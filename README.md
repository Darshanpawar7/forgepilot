# ForgePilot: a VS Code coding agent on TrueForge

ForgePilot is a Visual Studio Code extension whose **agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge)** in local mode. Given a real repository, it:
- finds the right code, even in a repository larger than the model's context window;
- plans and makes multi-file changes you never had to spell out file by file;
- shows **every change hunk by hunk before it touches disk**;
- keeps working when the model behind it fails.

Built for the TrueFoundry Forge-a-thon (Techfest, IIT Bombay 2026-27) by team **FLOWSTATE**.

**See it:** [project site with a replay of the recorded run](https://darshanpawar7.github.io/forgepilot/) · [demo video](https://darshanpawar7.github.io/forgepilot/#video) · [write-up (PDF)](docs/writeup.pdf)

**Starting point:** written from scratch, with no fork. Dependencies are the official TrueForge SDK, the MCP TypeScript SDK and `diff` (jsdiff).

## What it does

| Capability | How |
| --- | --- |
| **Inline edit** | Select code and press **Ctrl+Alt+K**, then type an instruction. The proposed change opens in VS Code's diff editor, and you tick or untick each hunk. |
| **Agent mode** | **ForgePilot: Open Agent Panel**. One request drives a TrueForge agent through a tool loop (search, read, edit, run tests) until the task is done. You never name the files. |
| **Context assembly** | Explicit `@file` and `@symbol` mentions, plus automatic retrieval: keywords from the request rank every file by rarity-weighted path and content hits. The best snippets and a map of the most relevant files are packed into a **fixed size budget** (24,000 characters by default). The panel lists what was chosen and why, and the agent then explores further with tools. |
| **Diff review** | Edits are **TrueForge tool calls that require approval**. TrueForge pauses the turn, the extension shows the diff, and you accept or reject each hunk. Only the accepted hunks are written. **ForgePilot: Undo Last Applied Change** reverts an applied change. |
| **Streaming and cancellation** | Tokens stream from TrueForge's events into the panel. **Cancel** (or Ctrl+Alt+X) calls `sessions.cancel`, kills any running command and drops pending reviews. Because nothing is written without approval, a cancelled run never leaves a half-applied edit. |
| **Resilience** | If a model fails (invalid key, endpoint unreachable), the editor stays responsive and ForgePilot **falls back automatically to the next configured model**. If all models fail, it shows a clear message, and your files are unchanged. |

## Architecture

```
VS Code extension (client)                         TrueForge (local mode, npx)
 ├─ panel / inline edit / diff review  ──SDK──►     sessions, streamed turns, approvals,
 ├─ context assembly (budgeted)                      compaction, sub-agents (enabled)
 └─ MCP server 127.0.0.1:8791 (bearer token) ◄──MCP── agent loop calls editor tools
      list_files, search_code, get_symbols, read_file,
      edit_file*, create_file*, run_command*      (* require approval: drive the diff review)
```

- The extension never calls a model provider. The model is chosen in TrueForge, and ForgePilot only names it, in fallback order.
- The agent definition is in [`agent/forgepilot.agent.json`](agent/forgepilot.agent.json). It contains the instructions and the MCP server with approval-gated tools, and it enables TrueForge's **compaction** and **dynamic sub-agents** as safety margins for long runs (neither was triggered in the recorded demo runs).

## Setup from a clean clone

Requirements: Node.js 22.14 or newer, VS Code 1.90 or newer, git. For the Flask tasks, you also need Python 3.10 or newer.

```bash
git clone https://github.com/Darshanpawar7/forgepilot && cd forgepilot
npm install

# 1. Start TrueForge in local mode. The extension's MCP server runs on 127.0.0.1, which
#    TrueForge's outbound network policy blocks unless it is allow-listed:
#    PowerShell:  $env:OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'; npx @truefoundry/trueforge@0.185.1
#    bash:        OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge@0.185.1

# 2. Open http://localhost:8790 and add at least one model provider (two for automatic fallback).

# 3. Launch VS Code with the extension on the target repository:
code --extensionDevelopmentPath="$PWD" /path/to/flask
```

Then copy [`forgepilot.example.json`](forgepilot.example.json) into the target workspace's `.vscode/settings.json` and set `forgepilot.models` to TrueForge model names in fallback order. **Never commit API keys**: keys live only in TrueForge.

## The three fixed tasks (pallets/flask 3.1.3, commit 22d92470)

```bash
git clone https://github.com/pallets/flask && cd flask && git checkout 3.1.3
python -m venv .venv && .venv/Scripts/pip install -e . "pytest<9" asgiref      # pytest 9 breaks Flask 3.1.3 conftest. Windows; use .venv/bin on macOS/Linux
```

- **A, inline edit:** select `get_debug_flag` in `src/flask/helpers.py`, press Ctrl+Alt+K, and give the instruction. Verify with `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`, which prints `False`.
- **B, agent mode:** in the panel, with no files named, give the `flask config` instruction. Verify with `pytest tests/test_cli.py -q` and `python -m flask --app <app> config`.
- **C, resilience:** set a wrong key or an unreachable endpoint for the first model in TrueForge, then repeat Task A. The editor stays responsive, the fallback takes over (or a clear error appears), and `git status` is clean.

## Licence

MIT, see [LICENSE](LICENSE).
