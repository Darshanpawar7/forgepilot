// ForgePilot: a VS Code coding agent whose agent loop runs on TrueForge (local mode).
// The extension is only a client: it creates TrueForge sessions, streams turns, renders events,
// and exposes the editor to the agent as MCP tools (workspaceTools.js). TrueForge's tool
// approval drives the hunk-by-hunk diff review (review.js), so nothing touches disk unreviewed.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
// The TrueForge SDK ships as an ES module, so it is loaded with import() on first use.
let TrueForgeCtor = null;
async function loadSdk() {
  if (!TrueForgeCtor) ({ TrueForge: TrueForgeCtor } = await import("@truefoundry/trueforge-sdk"));
  return TrueForgeCtor;
}
const { WorkspaceTools, readText, resolveInside, relPath } = require("./workspaceTools");
const { assemble } = require("./context");
const reviewUi = require("./review");

// Provider overload and network blips are retried on the same model before falling back.
const TRANSIENT_ERROR = /\b(429|500|502|503|504)\b|high demand|overloaded|timeout|timed out|ECONNRESET|Cannot connect/i;
const MAX_ATTEMPTS_PER_MODEL = 3;
const RETRY_DELAY_MS = 5000;

let tools, client, panel, status, extensionRoot;
let run = null; // { sessionId, cancelled }
const undoStack = [];

function cfg(key) { return vscode.workspace.getConfiguration("forgepilot").get(key); }

// ---------------------------------------------------------------- panel ----------------
function log(kind, text) {
  if (process.env.FORGEPILOT_TRACE) fs.appendFileSync(process.env.FORGEPILOT_TRACE, `LOG ${kind} ${text}\n`);
  if (panel) panel.webview.postMessage({ type: "log", kind, text });
}

function openPanel() {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside, true); return panel; }
  panel = vscode.window.createWebviewPanel("forgepilot", "ForgePilot Agent", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = fs.readFileSync(path.join(extensionRoot, "media", "panel.html"), "utf8");
  panel.webview.onDidReceiveMessage((m) => {
    if (m.type === "run" && m.text && m.text.trim()) startRun(m.text.trim(), {});
    if (m.type === "cancel") cancelRun();
  });
  panel.onDidDispose(() => { panel = null; });
  return panel;
}

function setStatus(text, busy) {
  status.text = `${busy ? "$(sync~spin)" : "$(hubot)"} ForgePilot: ${text}`;
  panel && panel.webview.postMessage({ type: "status", text, busy });
}

// ---------------------------------------------------------------- TrueForge -------------
async function ensureConnected() {
  const baseUrl = cfg("serverUrl");
  if (!client) client = new (await loadSdk())({ baseUrl, timeoutInSeconds: 600 });
  await client.settings.mcpServers.createOrUpdate({
    manifest: {
      name: "vscode-workspace",
      type: "remote",
      url: tools.url(),
      description: "The user's VS Code workspace: list/search/read files, propose edits (reviewed hunk by hunk), run commands.",
      auth: { type: "header", headers: { Authorization: `Bearer ${tools.token}` } },
    },
  });
}

async function modelOrder() {
  const configured = (cfg("models") || []).filter(Boolean);
  if (configured.length) return configured;
  try {
    const res = await client.models.list();
    return (res.data || []).map((m) => m.name || m.id).filter(Boolean).slice(0, 2);
  } catch { return []; }
}

function agentSpec(modelName) {
  const spec = JSON.parse(fs.readFileSync(path.join(extensionRoot, "agent", "forgepilot.agent.json"), "utf8"));
  delete spec.$comment;
  return { ...spec, model: { name: modelName } };
}

function toolName(tc) {
  const raw = (tc && ((tc.toolInfo && (tc.toolInfo.toolName || tc.toolInfo.name)) || (tc.function && tc.function.name))) || "";
  const known = ["edit_file", "create_file", "run_command", "read_file", "search_code", "list_files", "get_symbols"];
  return known.find((n) => raw === n || raw.endsWith(n)) || raw.split(/[./:]|__/).pop();
}

async function proposedText(args, isCreate) {
  const abs = resolveInside(args.path);
  if (isCreate) {
    if (fs.existsSync(abs)) return { error: `${args.path} already exists; use edit_file.` };
    return { before: "", after: args.content };
  }
  let raw;
  try { raw = await readText(abs); } catch { return { error: `${args.path} does not exist.` }; }
  // Compare with \n line endings (models send \n), then write back in the file's own style.
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lf = (s) => String(s || "").replace(/\r\n/g, "\n");
  const before = lf(raw), oldS = lf(args.old_string), newS = lf(args.new_string);
  const count = oldS ? before.split(oldS).length - 1 : 0;
  if (count === 0) return { error: `old_string was not found in ${args.path}. Read the file again and copy the exact text.` };
  if (count > 1) return { error: `old_string appears ${count} times in ${args.path}; include more surrounding lines so it is unique.` };
  return { before, after: before.replace(oldS, () => newS), eol };
}

// One decision per tool call waiting for approval. Edits go through the diff review.
async function decide(pending, calls) {
  const events = [];
  for (const { ref, threadId } of pending) {
    if (!run || run.cancelled) break;
    const tc = calls.get(ref.id);
    const name = toolName(tc);
    if (process.env.FORGEPILOT_TRACE) fs.appendFileSync(process.env.FORGEPILOT_TRACE, `PENDING ref=${JSON.stringify(ref)} thread=${threadId} found=${!!tc} name=${name} known=${[...calls.keys()].join(",")}\n`);
    let args = {};
    try { args = JSON.parse((tc && tc.function && tc.function.arguments) || "{}"); } catch { /* keep {} */ }
    let approval = { status: "allow" };
    if (!tc) {
      // Only write tools pause for approval, so an unidentified call is denied, never waved through.
      approval = { status: "deny", reason: "ForgePilot could not read this tool call, so it was not approved. Try the call again." };
      log("review", "denied an unidentified tool call");
    } else if (name === "edit_file" || name === "create_file") {
      const isCreate = name === "create_file";
      const p = await proposedText(args, isCreate);
      if (p.error) {
        approval = { status: "deny", reason: p.error };
        log("review", `auto-rejected (${p.error})`);
      } else {
        setStatus(`reviewing ${args.path}`, false);
        log("review", `review requested: ${args.path}`);
        const r = await reviewUi.review({ path: args.path, before: p.before, after: p.after, isCreate, title: "ForgePilot" });
        if (process.env.FORGEPILOT_TRACE) fs.appendFileSync(process.env.FORGEPILOT_TRACE, `REVIEW allow=${r.allow} ${WorkspaceTools.keyFor(args.path, isCreate ? "" : args.old_string, isCreate ? args.content : args.new_string)} ${JSON.stringify(args)}\n`);
        if (r.allow) {
          tools.decisions.set(WorkspaceTools.keyFor(args.path, isCreate ? "" : args.old_string, isCreate ? args.content : args.new_string),
            { acceptedText: p.eol === "\r\n" ? r.acceptedText.replace(/\r?\n/g, "\r\n") : r.acceptedText, partial: r.partial });
          log("review", `accepted ${r.partial ? "some hunks" : "all hunks"} of ${args.path}`);
        } else {
          approval = { status: "deny", reason: r.reason };
          run.userRejected = true;
          log("review", `rejected ${args.path}`);
        }
      }
    } else if (name === "run_command") {
      const demo = reviewUi.getDemoPolicy();
      let pick;
      if (demo) { vscode.window.showInformationMessage(`ForgePilot wants to run: ${args.command} (approved)`); await new Promise((r) => setTimeout(r, 1500)); pick = "Run"; }
      else pick = await vscode.window.showInformationMessage(`ForgePilot wants to run:\n${args.command}`, { modal: true }, "Run", "Deny");
      approval = pick === "Run" ? { status: "allow" } : { status: "deny", reason: "The user declined to run this command." };
      log("review", `${pick === "Run" ? "approved" : "denied"} command: ${args.command}`);
    }
    events.push({ type: "user.tool_approval", threadId, toolCallId: ref.id, approval });
  }
  return events;
}

// Reads one stream until it ends (turn.done, or paused for approval).
// Stream items can arrive bare or wrapped as { turnId, event }.
function unwrap(item) {
  if (item && item.event && item.event.type) return { turnId: item.turnId, ...item.event };
  if (item && item.data && item.data.type) return item.data;
  return item;
}

function recordCalls(ev, st) {
  for (const tc of ev.toolCalls || []) {
    if (!tc.function || st.calls.has(tc.id)) continue;
    st.calls.set(tc.id, tc);
    let a = "";
    try { a = JSON.stringify(JSON.parse(tc.function.arguments || "{}")).slice(0, 160); } catch { /* ignore */ }
    log("call", `${toolName(tc)} ${a}`);
  }
}

// Fallback: if a paused tool call was not seen on the stream, read the turn's events from TrueForge.
async function fetchMissingCalls(sessionId, st) {
  if (st.pending.every((p) => st.calls.has(p.ref.id))) return;
  const page = await client.sessions.listTurnEvents(sessionId, st.turnId, { limit: 200 });
  for await (const item of page) {
    const ev = unwrap(item);
    if (ev && ev.type === "model.message") recordCalls(ev, st);
  }
}

async function consume(stream, st) {
  for await (const raw of stream) {
    const ev = unwrap(raw);
    if (process.env.FORGEPILOT_TRACE) fs.appendFileSync(process.env.FORGEPILOT_TRACE, `EV ${ev.type} ${ev.type === "model.message" ? JSON.stringify(ev.toolCalls || []).slice(0, 200) : ""}\n`);
    if (ev.id) st.lastEventId = ev.id;
    switch (ev.type) {
      case "turn.created": st.turnId = ev.turnId || st.turnId; break;
      case "model.message.delta":
        if (ev.content) panel && panel.webview.postMessage({ type: "token", text: ev.content });
        break;
      case "model.message":
        panel && panel.webview.postMessage({ type: "endMessage" });
        recordCalls(ev, st);
        break;
      case "tool.response":
        log("result", (ev.content || "").split("\n").slice(0, 3).join(" | ").slice(0, 200));
        // Inline edit is one reviewed change: once it is written, end the session instead of letting the agent wander.
        if (run && run.inline && /^Applied to /.test(String(ev.content || ""))) {
          st.done = { status: "done" };
          try { await client.sessions.cancel(run.sessionId); } catch { /* already finished */ }
          return;
        }
        break;
      case "tool.approval_required":
        for (const ref of ev.toolCalls || []) st.pending.push({ ref, threadId: ev.threadId });
        break;
      case "turn.update":
        if (ev.state && ev.state.status) setStatus(ev.state.status === "paused" ? "waiting for your review" : "running", ev.state.status !== "paused");
        // The stream stays open while paused: stop reading so the review can run, then resume via subscribeToTurn.
        if (ev.state && ev.state.status === "paused" && st.pending.length) return;
        break;
      case "turn.done":
        st.done = ev.state;
        break;
      case "thread.created":
        log("info", `subagent thread started (${ev.threadId || ""})`);
        break;
      default: break;
    }
  }
}

async function runWithModel(modelName, message) {
  const session = await client.sessions.create({ agent: { spec: agentSpec(modelName) } });
  const sessionId = (session.data && session.data.id) || session.id;
  run.sessionId = sessionId;
  log("info", `TrueForge session ${sessionId} · model ${modelName} · open ${cfg("serverUrl")} to inspect it`);
  const st = { calls: new Map(), pending: [], done: null, turnId: null, lastEventId: null };
  await consume(await client.sessions.createTurnStream(sessionId, { input: [{ type: "user.message", content: message }] }), st);
  while (!st.done && !run.cancelled && st.pending.length && st.turnId) {
    try { await fetchMissingCalls(sessionId, st); } catch (e) { log("error", `could not read tool calls: ${e.message}`); }
    const pending = st.pending.splice(0);
    const events = await decide(pending, st.calls);
    if (run.cancelled) break;
    setStatus("running", true);
    const sub = await client.sessions.subscribeToTurn(sessionId, st.turnId, st.lastEventId ? { afterEventId: st.lastEventId } : {});
    await client.sessions.createTurnEvents(sessionId, st.turnId, { events });
    if (run.inline && run.userRejected) {
      try { await client.sessions.cancel(sessionId); } catch { /* already finished */ }
      return { status: "done", rejected: true };
    }
    await consume(sub, st);
  }
  return st.done || { status: run.cancelled ? "cancelled" : "error", message: "The turn ended without a result." };
}

async function startRun(request, { extra = "", label = "Agent", inline = false }) {
  if (run) { vscode.window.showWarningMessage("ForgePilot is already running. Cancel it first."); return; }
  openPanel();
  run = { sessionId: null, cancelled: false, inline };
  panel.webview.postMessage({ type: "start", text: `${label}: ${request}` });
  setStatus("starting", true);
  try {
    await ensureConnected();
    const models = await modelOrder();
    if (!models.length) throw new Error("No model is configured. Add a model provider in TrueForge and set forgepilot.models.");

    setStatus("choosing context", true);
    const ctx = await assemble(request, { budgetChars: cfg("contextBudgetChars"), extra });
    log("context", `budget ${ctx.used}/${ctx.budgetChars} chars · keywords: ${ctx.keywords.join(", ")}`);
    for (const r of ctx.report) log("context", r);
    const message = `${ctx.text}\n\n## Task\n${request}`;

    for (let i = 0; i < models.length; i++) {
      if (run.cancelled) break;
      setStatus(`running on ${models[i]}`, true);
      let result;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
        try { result = await runWithModel(models[i], message); }
        catch (e) { result = { status: "error", message: e.message || String(e) }; }
        const transient = result.status === "error" && TRANSIENT_ERROR.test(result.message || "");
        if (!transient || attempt === MAX_ATTEMPTS_PER_MODEL || run.cancelled) break;
        log("error", `Model ${models[i]} is temporarily unavailable (${(result.message || "").slice(0, 100)}).`);
        log("info", `Retrying ${models[i]} in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1} of ${MAX_ATTEMPTS_PER_MODEL}).`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
      if (result.rejected) { log("done", "You rejected the change, so nothing was written. Your files are unchanged."); break; }
      if (result.status === "done") { log("done", "Done. Review the changes in the editor; use “ForgePilot: Undo Last Applied Change” to revert."); break; }
      if (result.status === "cancelled" || run.cancelled) { log("cancelled", "Cancelled. Nothing half-applied: only accepted hunks were ever written."); break; }
      const msg = result.message || "unknown error";
      if (i < models.length - 1) {
        log("error", `Model ${models[i]} failed: ${msg}`);
        log("info", `Falling back to ${models[i + 1]} automatically. Your files were not changed.`);
        vscode.window.showWarningMessage(`ForgePilot: ${models[i]} failed (${msg.slice(0, 120)}). Falling back to ${models[i + 1]}.`);
      } else {
        log("error", `All configured models failed. Last error: ${msg}. Your files were not changed.`);
        vscode.window.showErrorMessage(`ForgePilot: the model is unavailable (${msg.slice(0, 160)}). Your files were not changed.`);
      }
    }
  } catch (e) {
    log("error", `${e.message || e}`);
    vscode.window.showErrorMessage(`ForgePilot: ${e.message || e}`);
  } finally {
    run = null;
    setStatus("idle", false);
    panel && panel.webview.postMessage({ type: "finished" });
  }
}

async function cancelRun() {
  if (!run) return;
  run.cancelled = true;
  setStatus("cancelling", true);
  tools.cancelAll();
  try { if (run.sessionId) await client.sessions.cancel(run.sessionId); } catch (e) { log("error", `cancel: ${e.message}`); }
  log("cancelled", "Cancel requested.");
}

// ---------------------------------------------------------------- commands -------------
async function inlineEdit(args) {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) { vscode.window.showInformationMessage("Select some code first."); return; }
  const instruction = (args && args.instruction) || await vscode.window.showInputBox({ prompt: "ForgePilot inline edit: what should change?", ignoreFocusOut: true });
  if (!instruction) return;
  const file = relPath(ed.document.uri.fsPath);
  const a = ed.selection.start.line + 1, b = ed.selection.end.line + 1;
  const lines = ed.document.getText(ed.selection).split(/\r?\n/).map((l, i) => `${a + i}\t${l}`).join("\n");
  const request = `Inline edit of ${file}, lines ${a}-${b} (the selection). Instruction: ${instruction}\n` +
    `Change only the selected code (including its docstring). Make exactly one edit_file call on ${file}, then stop.`;
  await startRun(request, { extra: `${file} lines ${a}-${b}:\n${lines}`, label: "Inline edit", inline: true });
}

async function undoLast() {
  const last = undoStack.pop();
  if (!last) { vscode.window.showInformationMessage("Nothing to undo."); return; }
  const abs = resolveInside(last.file);
  if (last.isCreate) { await fs.promises.unlink(abs); }
  else {
    const uri = vscode.Uri.file(abs);
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), last.before);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  }
  log("apply", `undone: ${last.file}`);
  vscode.window.showInformationMessage(`ForgePilot: undid the change to ${last.file}.`);
}

async function activate(context) {
  extensionRoot = context.extensionPath;
  reviewUi.register(context);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "forgepilot.openAgent";
  status.show();
  setStatus("idle", false);
  tools = new WorkspaceTools(log, { onApply: (file, before, after, isCreate) => undoStack.push({ file, before, after, isCreate }) });
  try { await tools.start(cfg("mcpPort")); }
  catch (e) { vscode.window.showErrorMessage(`ForgePilot could not start its MCP server on port ${cfg("mcpPort")}: ${e.message}`); }
  context.subscriptions.push(
    vscode.commands.registerCommand("forgepilot.openAgent", openPanel),
    vscode.commands.registerCommand("forgepilot.runAgent", (text) => startRun(text, {})),
    vscode.commands.registerCommand("forgepilot._demoPolicy", (p) => reviewUi.setDemoPolicy(p || null)),
    vscode.commands.registerCommand("forgepilot._typeInPanel", (text) => panel && panel.webview.postMessage({ type: "type", text })),
    vscode.commands.registerCommand("forgepilot.inlineEdit", inlineEdit),
    vscode.commands.registerCommand("forgepilot.cancel", cancelRun),
    vscode.commands.registerCommand("forgepilot.undoLast", undoLast),
    status,
    { dispose: () => tools.stop() },
  );
  // Scripted demo for recording: runs only if demo/autorun.flag exists (deleted on use).
  const flag = path.join(extensionRoot, "demo", "autorun.flag");
  if (fs.existsSync(flag)) {
    fs.unlinkSync(flag);
    setTimeout(() => require("../demo/driver").run(), 6000);
  }
}

function deactivate() { if (tools) tools.stop(); }

module.exports = { activate, deactivate };
