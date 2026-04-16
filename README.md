# Claude Token Saver

A Claude Code `UserPromptSubmit` hook that refines your prompts before sending them to Claude. When activated, it rewrites your prompt to be token-efficient and precise, and surfaces relevant best practice tips. It is **off by default** — you activate it deliberately for one prompt at a time.

---

## How it works

Token Saver is **off by default**. Every prompt passes through to Claude untouched and unread unless you explicitly activate it.

When you type `--tokensaver`, it activates for your **next prompt only**. That prompt is sent to a local Ollama model which:

1. Rewrites it to be token-efficient and technically precise
2. Selects relevant best practice tips (0–3 max)

A gate is then shown so you can review the refinement before deciding what to send. After you respond to the gate, Token Saver turns off automatically — your next prompt goes through as normal.

```
--tokensaver          ← you type this
Token Saver ON        ← confirmed, waiting for your prompt

[your next prompt]    ← this one gets refined

Token Saver
──────────────────────────────────────
Original : [your prompt]
Refined  : [rewritten version]
──────────────────────────────────────
  y        → send refined
  n        → send original
  c        → cancel (discard prompt)
  edit: …  → adjust the refinement
                                      ← Token Saver is now off again
```

---

## Setup

### 1. Check Node.js version

Requires Node.js 18 or higher (for the built-in `fetch` API):

```bash
node --version
```

Download from [nodejs.org](https://nodejs.org) if needed. No `npm install` required — there are no dependencies.

### 2. Install Ollama and pull a model

Download Ollama from [ollama.com](https://ollama.com), then pull the recommended model:

```bash
ollama pull qwen2.5:32b
```

> **Why a local model?** Every prompt you type passes through Token Saver. Running a local model keeps your prompts private, fast, and free. It has been tested on `qwen2.5:32b`, which follows JSON output instructions reliably. Smaller models tend to produce malformed output.

**To use a different model**, update `MODEL_ID` at the top of `tokensaver.js` and pull it:

```js
const MODEL_ID = 'qwen2.5:32b'; // change this
```

```bash
ollama pull <model-name>
```

### 3. Copy the prompt file

The refinement behaviour is controlled by `prompts/refine.txt`. This file must live next to `tokensaver.js`:

```
claude-token-saver/
  tokensaver.js
  prompts/
    refine.txt
```

See [Customising refinement](#customising-refinement) to edit it.

### 4. Register the hook in Claude Code

Add the following to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/claude-token-saver/tokensaver.js"
          }
        ]
      }
    ]
  }
}
```

Adjust the path if you placed the project elsewhere.

### 5. Start Ollama

```bash
ollama serve
```

---

## Usage

### Activate for one prompt

```
--tokensaver
```

Token Saver confirms it's ON, then waits. Type your next prompt — it will be refined and shown in the gate. After you respond (`y`, `n`, `c`), Token Saver turns off automatically. If you respond `edit:<instruction>`, Token Saver adds your edits and suggests a new refined prompt.  

### Cancel activation

If you activated Token Saver but changed your mind before typing your prompt:

```
--tokensaver:off
```

### Gate commands

| Input | Effect |
|---|---|
| `y` / `yes` / `proceed` | Send the refined prompt |
| `n` / `no` | Send the original prompt unchanged |
| `c` / `cancel` | Discard the prompt entirely |
| `edit: <instruction>` | Ask the model to adjust the refinement, then re-show the gate |

---

## Token Saver tips

If the model identifies best practices relevant to your prompt, it includes up to 3 tips below the gate. These are only shown when applicable — never for every prompt. Available tips cover:

- Activating Plan Mode for complex/architectural tasks
- Providing specific file paths when none are mentioned
- Defining success criteria when the done condition is vague
- Limiting search scope when asking Claude to find something without bounds
- Flagging large files in the prompt that should be read by a subagent

---

## Customising refinement

The refinement and tip behaviour is controlled by `prompts/refine.txt`. Edit it freely to:

- Change how prompts are rewritten
- Add, remove, or reword available tips
- Adjust tone or verbosity of refinements

**Important:** `refine.txt` must stay in the `prompts/` folder next to `tokensaver.js`. If you move or copy the project, copy the `prompts/` folder with it.

---

## File structure

```
claude-token-saver/
  tokensaver.js       Main hook script
  prompts/
    refine.txt        System prompt controlling refinement and tips
  .state.json         Temporary gate state (auto-managed, expires in 5 min)
  .session.json       Persists activation state between prompts
```
