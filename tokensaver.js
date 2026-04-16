#!/usr/bin/env node
/**
 * UserPromptSubmit hook — Token Saver
 *
 * Off by default. Activate for a single prompt with --tokensaver.
 * Every activated prompt is refined by a local Ollama model before sending to Claude.
 *
 * Commands:
 *   --tokensaver          → activate for next prompt
 *   --tokensaver:off      → cancel activation
 *
 * Gate commands (shown after refinement):
 *   y / yes / proceed   → send refined (or original if no refinement)
 *   n / no              → send original
 *   c / cancel          → discard prompt
 *   edit: <instruction> → adjust the refinement
 *
 * State is stored in .state.json next to this script, expires after 5 min.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Config ────────────────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url));

const OLLAMA_URL           = 'http://localhost:11434/v1/chat/completions';
const MODEL_ID             = 'qwen2.5:32b';
const STATE_TTL_MS         = 5 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.85;

const EDIT_SYSTEM = 'You are a prompt rewriter. The user has a refined prompt and wants to adjust it.\nOutput ONLY the updated rewritten prompt — no preamble, no labels, no quotes.';

const PATHS = {
  state:         path.join(__dir, '.state.json'),
  session:       path.join(__dir, '.session.json'),
  rules:         path.join(__dir, 'claude-rules.md'),
  refinePrompt:  path.join(__dir, 'prompts', 'refine.txt'),
};

// ── File helpers ──────────────────────────────────────────────────────────────

function readFileSafe(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); }
  catch { return ''; }
}

function buildRefineSystem() {
  const rules = readFileSafe(PATHS.rules);
  const prefix = rules ? `Historical Lessons:\n${rules}\n\n---\n\n` : '';
  return prefix + readFileSafe(PATHS.refinePrompt);
}

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(PATHS.state, 'utf8'));
    if (Date.now() - s.ts > STATE_TTL_MS) { clearState(); return null; }
    return s;
  } catch { return null; }
}

function saveState(s) {
  fs.writeFileSync(PATHS.state, JSON.stringify({ ...s, ts: Date.now() }));
}

function clearState() {
  try { fs.unlinkSync(PATHS.state); } catch {}
}

function loadSession() {
  try { return JSON.parse(fs.readFileSync(PATHS.session, 'utf8')); }
  catch { return {}; }
}

function saveSession(s) {
  fs.writeFileSync(PATHS.session, JSON.stringify(s));
}

// ── Hook outputs ──────────────────────────────────────────────────────────────

function block(msg) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: msg }));
  process.exit(2);
}

function allow(prompt) {
  process.stdout.write(prompt);
  process.exit(0);
}

// ── Ollama ────────────────────────────────────────────────────────────────────

async function ollamaCall(messages, maxTokens = 600) {
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_ID, messages, max_tokens: maxTokens, temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`Ollama API ${res.status}: ${await res.text()}`);
  return (await res.json()).choices?.[0]?.message?.content?.trim() ?? '';
}

function parseRefineResponse(raw) {
  // Extract the first JSON object from the response, ignoring any surrounding text
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in response');
  const p = JSON.parse(match[0]);

  const refined = typeof p.refined === 'string' && p.refined.trim() ? p.refined.trim() : null;
  const tips    = Array.isArray(p.tips)
    ? p.tips
        .filter(t => typeof t === 'string')
        .map(t => t.replace(/^\[.*?\]\s*\|\s*"?/, '').replace(/"$/, '').trim())
    : [];

  return { refined, tips };
}

async function refinePrompt(original, fileContext) {
  const userContent = fileContext
    ? `${original}\n\n[File context — files detected in prompt: ${fileContext}]`
    : original;

  const raw = await ollamaCall([
    { role: 'system', content: buildRefineSystem() },
    { role: 'user',   content: userContent },
  ]);

  try {
    return parseRefineResponse(raw);
  } catch {
    return { refined: null, tips: [] };
  }
}

async function refineWithEdit(original, previous, instruction) {
  return ollamaCall([
    { role: 'system',    content: EDIT_SYSTEM },
    { role: 'user',      content: original },
    { role: 'assistant', content: previous },
    { role: 'user',      content: `Adjust: ${instruction}` },
  ], 512);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Jaccard similarity over word sets. Returns 0–1. */
function wordSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().match(/\w+/g) ?? []);
  const setB = new Set(b.toLowerCase().match(/\w+/g) ?? []);
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union        = new Set([...setA, ...setB]).size;
  return union === 0 ? 1 : intersection / union;
}

const FILE_PATH_RE = /(?:^|[\s"'`(,])(\.{0,2}\/(?:[\w.\-]+\/)*[\w.\-]+\.[\w]+|[\w.\-]+\/[\w.\-]+\.[\w]+)/gm;

/** Scan the prompt for file paths that exist on disk. Returns a map of resolvedPath → sizeKB. */
function resolveFiles(promptText) {
  const cwd   = process.cwd();
  const found = new Map();
  let match;
  FILE_PATH_RE.lastIndex = 0;
  while ((match = FILE_PATH_RE.exec(promptText)) !== null) {
    const candidate = match[1].trim();
    const resolved  = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    if (found.has(resolved)) continue;
    try { found.set(resolved, fs.statSync(resolved).size / 1024); }
    catch { /* not a real file — skip */ }
  }
  return found;
}

function buildFileContext(promptText) {
  const files = resolveFiles(promptText);
  if (files.size === 0) return null;
  return [...files.entries()]
    .map(([filePath, kb]) => `${path.basename(filePath)} (${Math.round(kb)}KB)`)
    .join(', ');
}

// ── Gate UI ───────────────────────────────────────────────────────────────────

const DIVIDER = '──────────────────────────────────────';

function gateMessage(original, refined, tips = []) {
  let msg = `Token Saver\n${DIVIDER}\n`;

  if (refined !== null) {
    msg +=
      `Original : ${original}\n` +
      `Refined  : ${refined}\n` +
      `${DIVIDER}\n` +
      `  y        → send refined\n` +
      `  n        → send original\n` +
      `  c        → cancel (discard prompt)\n` +
      `  edit: …  → adjust the refinement\n`;
  } else {
    msg +=
      `Prompt   : ${original}\n` +
      `${DIVIDER}\n` +
      `  y        → send as-is\n` +
      `  c        → cancel (discard prompt)\n` +
      `  edit: …  → rewrite with instruction\n`;
  }

  if (tips.length > 0) {
    msg += `\nToken Saver tips:\n${tips.map(t => `  • ${t}`).join('\n')}\n`;
  }

  msg += `\n[Controls: -- [YOUR PROMPT] to skip refinement | --tokensaver to arm for next prompt]`;

  return msg;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const raw = await new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data',  chunk => (buf += chunk));
    process.stdin.on('end',   () => resolve(buf.trim()));
    process.stdin.on('error', reject);
  });

  let prompt;
  try {
    const input = JSON.parse(raw);
    prompt = (input.prompt ?? '').trim();
  } catch {
    prompt = raw;
  }

  if (!prompt) allow('');

  // Handle --tokensaver commands
  if (/^--tokensaver$/i.test(prompt.trim())) {
    const sess = loadSession();
    saveSession({ ...sess, tokenSaverOn: true });
    clearState();
    block('Token Saver ON — type your next prompt to refine it.\n\n[Controls: --tokensaver:off to cancel]');
  }

  if (/^--tokensaver:off$/i.test(prompt.trim())) {
    const sess = loadSession();
    saveSession({ ...sess, tokenSaverOn: false });
    clearState();
    block('Token Saver cancelled.');
  }

  const sess = loadSession();

  // Turn 2: handle gate response (must come before on check, as on is cleared after Turn 1)
  const state = loadState();
  if (state) {
    const cmd = prompt.trim().toLowerCase();

    if (cmd === 'y' || cmd === 'yes' || cmd === 'proceed') {
      clearState();
      allow(state.refined ?? state.original);
    }

    if ((cmd === 'n' || cmd === 'no') && state.refined !== null) {
      clearState();
      allow(state.original);
    }

    if (cmd === 'c' || cmd === 'cancel') {
      clearState();
      block('Prompt cancelled.');
    }

    if (/^edit[: ]/i.test(prompt.trim())) {
      const instruction = prompt.trim().replace(/^edit[: ]*/i, '').trim();
      let updated = state.refined ?? state.original;
      try {
        updated = await refineWithEdit(state.original, state.refined ?? state.original, instruction);
      } catch { /* keep existing on failure */ }
      saveState({ original: state.original, refined: updated, tips: state.tips });
      block(gateMessage(state.original, updated, state.tips));
    }

    block(gateMessage(state.original, state.refined, state.tips));
  }

  // Not on — pass through
  if (!sess.tokenSaverOn) {
    allow(prompt);
  }

  // Turn off — this prompt will be processed, next one passes through
  saveSession({ ...sess, tokenSaverOn: false });

  // Refine the prompt
  let result;
  try {
    result = await refinePrompt(prompt, buildFileContext(prompt));
  } catch (err) {
    process.stderr.write(`[token-saver] ${err.message}\n`);
    allow(prompt);
  }

  // Always refine — discard only if too similar to original
  const refined = wordSimilarity(prompt, result.refined ?? '') >= SIMILARITY_THRESHOLD
    ? null
    : result.refined;

  saveState({ original: prompt, refined, tips: result.tips });
  block(gateMessage(prompt, refined, result.tips));
}

main().catch(err => {
  clearState();
  process.stderr.write(`[tokensaver.js] ${err.message}\n`);
  process.exit(1);
});
