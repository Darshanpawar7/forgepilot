# ForgePilot: an editor-native coding agent on TrueForge

## 1. Team
FLOWSTATE (Techfest Team ID TM-E8DADAC3DAF). Darshan P Pawar, B.Tech Computer Science, PES University, Bengaluru. GitHub: @Darshanpawar7.

## 2. Starting point
From scratch. No upstream coding assistant was forked. The editor side uses only VS Code's own APIs: the diff editor, QuickPick, webview and WorkspaceEdit. The dependencies are `@truefoundry/trueforge-sdk` 0.185.0 (client), `@truefoundry/trueforge` 0.185.1 (local server), `@modelcontextprotocol/sdk` 1.32.2 (MCP server) and `diff` 9.0.0 (hunks).

## 3. Architecture on TrueForge
- **TrueForge runs the agent loop in local mode** (`npx @truefoundry/trueforge@0.185.1`, SQLite). The extension never calls a model provider. It only names TrueForge models, in fallback order.
- **Client:** the extension creates a session for each request with the inline agent spec from `agent/forgepilot.agent.json`. It streams the turn with `sessions.createTurnStream`, renders `model.message.delta` tokens and the tool calls, and resumes paused turns with `subscribeToTurn` and `createTurnEvents`.
- **Editor capabilities as MCP tools:** the extension hosts an MCP server (Streamable HTTP) on 127.0.0.1, protected by a random bearer token. It is registered with `settings.mcpServers.createOrUpdate`. TrueForge's outbound policy is opened only for 127.0.0.1 (`OUTBOUND_URL_ALLOWED_HOSTS`).
  - Read-only tools: `list_files`, `search_code`, `get_symbols`, `read_file`.
  - Write tools: `edit_file`, `create_file`, `run_command`.
  The agent, not the extension, decides what to read and change.
- **TrueForge tool approval drives the diff review:** the write tools are listed in `requireApprovalForTools`.
  1. When the agent calls one, TrueForge pauses the turn (`tool.approval_required`).
  2. The extension computes the full proposed file and opens it in VS Code's diff editor.
  3. The user ticks or unticks each hunk.
  4. The extension sends `user.tool_approval` allow, recording the accepted hunks, or deny with a reason the agent can act on.
  5. Only then does TrueForge call the MCP tool, which writes exactly the accepted hunks through a `WorkspaceEdit`. Nothing reaches disk without review, and an undo stack reverts any applied change.
- **Harness features used:**
  - **Compaction** (`contextManagement.compaction`) keeps long multi-file runs inside the window.
  - **Dynamic sub-agents** (`dynamicSubAgents`) let the agent delegate a focused search.
  - **Preloaded MCP tools** (`preload`) make the workspace tools visible from the first step.
  - **Iteration limit:** a safety cap on the loop.
- **Robust edit matching:** `old_string` is matched with normalised line endings, and the accepted text is written back in the file's own style (the Flask checkout uses CRLF on Windows). An inline edit ends its session as soon as its single reviewed change is written or rejected.
- **Cancellation:** `sessions.cancel`, plus killing any running command and dropping pending reviews. A cancelled run cannot leave a half-applied edit, because edits are written only after approval, and each one is applied atomically.

## 4. How context is selected
Every request first gets a **context pack** with a fixed budget (24,000 characters by default; it is a setting). The panel shows exactly what went in and why:
1. **Explicit mentions:** `@path/to/file` (resolved by suffix) and `@symbol` (the definition, found by a def/class scan) are added first.
2. **Automatic retrieval:**
   - Keywords are taken from the request, including the parts of snake_case words.
   - Every text file is scored by **rarity-weighted keyword hits** (IDF), plus a boost for keywords in the path. Test files get a small penalty.
   - A compact **map of the top 8 files** goes in: path, score, matched keywords and top-level symbols.
   - Then come **snippets around the strongest hits** in the top 5 files, until the budget is full.
3. **Agent-driven retrieval:** the pack is a starting point. The agent then uses `search_code`, `get_symbols` and `read_file` (line ranges) to explore further. Because the instructions forbid editing a file it has not read, it reads before it writes.

Flask 3.1.3 (about 17,000 lines across src and tests) never enters the window whole. In Task B the panel shows the keywords, the files chosen with their scores, and then the agent's own searches.

## 5. Model setup
- **Primary:** `google-gemini/gemini-3-5-flash-lite`. **Fallback:** `google-gemini/gemini-3-1-flash-lite`. Both are configured in TrueForge as the Google Gemini catalog provider and use Google AI Studio's free tier, so the approximate cost is **₹0**.
- **Task C:** the first model in the list is `openai/gpt-5-4-mini`, configured in TrueForge with an **invalid API key**.
- **Fallback:** ForgePilot tries the models in `forgepilot.models` in order. On a `turn.done` with status `error` (for example "Request failed (401): Invalid API Key"), it starts the same request on the next model automatically and tells the user. The workspace is untouched, because nothing is written without approval.
- **Retry before fallback:** temporary provider errors (429/5xx, "high demand", timeouts) are retried once on the same model after 3 seconds; a hard error such as a bad key falls back straight away. During recording, Gemini returned a real 503 "high demand" in Task A and the retry recovered it.
- **To switch models,** add a provider in the TrueForge UI and edit `forgepilot.models` in the workspace settings (see `forgepilot.example.json`). No keys are stored in the repository.

## 6. Scorecard
| Criterion | Video | Claim |
| --- | --- | --- |
| A1 Inline edit | TBD | Ctrl+Alt+K on the selection. The diff renders in the editor with a per-hunk accept/reject list |
| A2 Agent mode | TBD | One panel request. The agent finds and edits the CLI module, the tests and the docs unprompted |
| A3 Streaming and cancellation | TBD | Tokens stream into the panel. Cancel stops the TrueForge session, and nothing is half-applied |
| B1 Context assembly | TBD | Budgeted pack: keywords, ranked files with scores and reasons, then the agent's own searches, all visible in the panel |
| B2 Diff safety | TBD | Per-hunk review before any write; "Undo Last Applied Change" reverts the applied edit on screen |
| B3 Resilience | TBD | The invalid-key model fails, the fallback to Gemini happens automatically, and `git status` is clean |
| B4 TrueForge depth | TBD | Editor actions are MCP tools, and TrueForge's tool approval drives the diff review. Compaction and dynamic sub-agents are enabled; the session is shown in the TrueForge UI |

## 7. Tools used
VS Code Extension API, the TrueForge SDK and server, the MCP TypeScript SDK, jsdiff, and ffmpeg (screen recording). Claude Code (Anthropic) was used as an AI coding assistant while building the extension.

## 8. Known limitations and what we would do with another month
- Retrieval is lexical. We would add an embedding index, and use language-server symbols for `@symbol` instead of a regular-expression scan.
- Hunk review uses VS Code's diff editor plus a hunk checklist. We would add inline CodeLens accept/reject on each hunk.
- Undo works per applied change. We would add checkpoints per agent run, so a whole run can be reverted at once.
- Inline edit runs as a short agent session. We would add a lighter one-shot path for very small edits.
- The demo was recorded in one continuous take with the review clicks scripted (`demo/driver.js`), to fit the 4-minute limit; the same review UI is used interactively. The stretches where the model is thinking are sped up, and the video labels them on screen.
- Gemini Flash-Lite answers in about 10 seconds per step, so Task B takes several minutes in real time. A faster or self-hosted model behind TrueForge would cut this without code changes.
