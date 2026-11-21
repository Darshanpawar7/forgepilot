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
- **Primary:** `google-gemini/gemini-3-5-flash-lite`. **Fallback:** `google-gemini/gemini-3-1-flash-lite` (the models in the recorded run). Both are configured in TrueForge as the Google Gemini catalog provider and use Google AI Studio's free tier, so the approximate cost is **₹0**.
- **Task C:** the first model in the list is `openai/gpt-5-4-mini`, configured in TrueForge with an **invalid API key**.
- **Back-off and resume:** a temporary provider error (429/5xx, quota, "high demand", timeouts) is not a restart. ForgePilot waits (20/40/60 s for rate limits, 5/10/20 s for overloads) and then opens a **new turn in the same TrueForge session**, so the agent keeps everything it has already read and done. In the recorded Task B the free tier rate-limited the models six times (five back-offs and one fallback) and the run still finished.
- **Fallback:** a hard error (for example "Request failed (401): Invalid API Key"), or a model that stays unavailable, moves the request to the next model in `forgepilot.models` automatically. The message says truthfully what happened to the workspace: either nothing was written, or how many already-accepted changes stay in place (Undo reverts them).
- **To switch models,** add a provider in the TrueForge UI and edit `forgepilot.models` in the workspace settings (see `forgepilot.example.json`). No keys are stored in the repository.

## 6. Scorecard
| Criterion | Video | Claim |
| --- | --- | --- |
| A1 Inline edit | 0:06-0:30 | Inline edit on the selected function (command "ForgePilot: Inline Edit", Ctrl+Alt+K). The diff opens in the editor; `FLASK_DEBUG=off` then prints False in the terminal (0:21) |
| A2 Agent mode | 0:33-3:05 | One panel request, no files named. The agent finds `src/flask/cli.py`, registers and writes `config_command`, adds `test_config_command` to `tests/test_cli.py`, documents it in `docs/cli.rst` next to the other built-in commands, and runs the tests itself. Verified on screen (2:38-3:05): 56 passed, `flask config` prints masked JSON, `config` is in `flask --help`, and `git diff --stat` shows 3 files, 65 insertions, 0 deletions |
| A3 Streaming and cancellation | 0:33-2:37, 3:15-3:32 | Tokens and tool calls stream into the panel. At 3:15 a new request is cancelled while the agent is running the test suite: `sessions.cancel`, the command is killed ("client-cancelled"), and `git status` is clean |
| B1 Context assembly | 0:33-0:45 | Budgeted pack (9,506 of 24,000 chars): keywords, ranked files and the reason each was chosen, then the agent's own searches, all listed in the panel |
| B2 Diff safety | 0:12-0:27, 1:03-2:37 | Per-hunk review before every write (diff editor plus hunk checklist); one edit whose text did not match the file was refused automatically; "Undo Last Applied Change" reverts Task A's edit (0:27) |
| B3 Resilience | 0:45-2:37, 3:33-3:49 | Task B: six real 429s; five back-offs, each followed by a new turn in the same session, and one fallback that keeps the accepted work. Task C: `openai/gpt-5-4-mini` with an invalid key fails (401), ForgePilot falls back to Gemini, the change is rejected, and `git status` is clean |
| B4 TrueForge depth | 3:06-3:13 | Editor actions are MCP tools; TrueForge's tool approval drives the diff review; resumption uses new turns in the same session; compaction and dynamic sub-agents are on; the TrueForge UI is shown at 3:06 |

## 7. Tools used
VS Code Extension API, the TrueForge SDK and server, the MCP TypeScript SDK, jsdiff, ffmpeg (screen recording and editing), and Indic Parler-TTS (AI4Bharat, Apache-2.0) run locally for the video narration, which is a synthetic voice. Claude Code (Anthropic) was used as an AI coding assistant while building the extension.

## 8. Known limitations and what we would do with another month
- Retrieval is lexical. We would add an embedding index, and use language-server symbols for `@symbol` instead of a regular-expression scan.
- Hunk review uses VS Code's diff editor plus a hunk checklist. We would add inline CodeLens accept/reject on each hunk.
- Undo works per applied change. We would add checkpoints per agent run, so a whole run can be reverted at once.
- Inline edit runs as a short agent session. We would add a lighter one-shot path for very small edits.
- The demo run is scripted (`demo/driver.js`): it runs the same commands and accepts or rejects hunks in the same review UI a user would, to fit the 4-minute limit. It is one continuous take; the stretches where the model is thinking or waiting out a rate limit are sped up (3.8x) and labelled on screen.
- A scripted "accept all" is only as good as the agent. In one rehearsal the agent weakened two unrelated Flask path tests: ForgePilot's `run_command` ran from `c:\...` (VS Code's lower-case drive letter) and those tests compare paths exactly. We fixed the root cause (the workspace root now uses Windows' normal drive letter) and the instructions now forbid deleting or weakening existing tests. In the recorded run the test file has additions only. A human reviewer is the real safeguard; per-file review policies are next on our list.
- The free Gemini tier is slow and rate-limited (Task B takes about eight minutes in real time, most of it waiting out 429s). A paid or self-hosted model behind TrueForge would cut this without code changes.
