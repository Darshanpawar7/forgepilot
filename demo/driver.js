// Scripted demo: runs the three fixed tasks in a real VS Code window so the screen can be recorded.
// Run with:  code --extensionDevelopmentPath=<repo> --extensionTestsPath=<repo>/demo/driver.js <flask checkout>
// The review "clicks" are scripted through forgepilot._demoPolicy; everything else is the real extension.
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const LOG = process.env.FORGEPILOT_DEMO_LOG || path.join(__dirname, "demo-log.txt");
const PY = process.env.FORGEPILOT_DEMO_PY || "C:/Users/darsh/oss-work/forge-a-thon/.venv-flask/Scripts";
const APP = process.env.FORGEPILOT_DEMO_APP || "C:/Users/darsh/oss-work/demo_app.py";
const PRIMARY = ["google-gemini/gemini-3-6-flash", "google-gemini/gemini-3-5-flash-lite"];
const BROKEN_FIRST = ["openai/gpt-5-4-mini", "google-gemini/gemini-3-6-flash"];
const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B = "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as \"***\". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.";

const ONLY = process.env.FORGEPILOT_DEMO_ONLY || "ABC";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] ${a.join(" ")}\n`);
// VS Code reports "c:\\..."; Flask's path tests expect the usual upper-case drive letter.
const root = () => vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ":");
function sh(cmd, env = {}) {
  try {
    return cp.execSync(cmd, { cwd: root(), env: { ...process.env, PATH: `${PY};${process.env.PATH}`, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180000 });
  } catch (e) { return `EXIT ${e.status}\n${e.stdout || ""}${e.stderr || ""}`; }
}
let term;
function show(cmd) {
  if (!term) term = vscode.window.createTerminal({ name: "verify", cwd: root(), env: { PATH: `${PY};${process.env.PATH}` } });
  term.show(true);
  term.sendText(cmd);
}
async function setModels(list) { await vscode.workspace.getConfiguration("forgepilot").update("models", list, vscode.ConfigurationTarget.Workspace); }
async function selectFunction(file, name) {
  const doc = await vscode.workspace.openTextDocument(path.join(root(), file));
  const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const lines = doc.getText().split(/\r?\n/);
  const a = lines.findIndex((l) => l.startsWith(`def ${name}(`));
  let b = a + 1;
  while (b < lines.length && (lines[b] === "" || /^\s/.test(lines[b]))) b++;
  while (b > a && lines[b - 1] === "") b--;
  ed.selection = new vscode.Selection(a, 0, b - 1, lines[b - 1].length);
  ed.revealRange(new vscode.Range(a, 0, b, 0), vscode.TextEditorRevealType.InCenter);
  return { a: a + 1, b };
}

async function run() {
  fs.writeFileSync(LOG, "");
  try {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const c of ["workbench.action.closeAuxiliaryBar", "workbench.action.closeSidebar", "notifications.clearAll"]) { try { await vscode.commands.executeCommand(c); } catch { /* not available */ } }
    await setModels(PRIMARY);
    await vscode.commands.executeCommand("forgepilot._demoPolicy", { action: "accept", delayMs: 4500 });
    log("git status before:", JSON.stringify(sh("git status --short")));

    // ---------------- Task A: inline edit ----------------
    if (ONLY.includes("A")) {
    const sel = await selectFunction("src/flask/helpers.py", "get_debug_flag");
    log("Task A selection lines", sel.a, sel.b);
    await sleep(2500);
    log("MARK fast on");
    await vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: TASK_A });
    log("MARK fast off");
    log("Task A diff:\n" + sh("git diff --stat") + sh("git diff"));
    const vA = sh(`python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`, { FLASK_DEBUG: "off" });
    log("Task A verify (FLASK_DEBUG=off):", vA.trim());
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    show(`$env:FLASK_DEBUG='off'; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"; Remove-Item Env:FLASK_DEBUG`);
    await sleep(6000);
    // show undo: revert the applied change, proving it is undoable
    await vscode.commands.executeCommand("forgepilot.undoLast");
    await sleep(2500);
    log("after undo git status:", JSON.stringify(sh("git status --short")));

    }
    // ---------------- Task B: agent mode ----------------
    if (ONLY.includes("B")) {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("forgepilot.openAgent");
    await vscode.commands.executeCommand("forgepilot._typeInPanel", TASK_B);
    await sleep(3000);
    log("MARK fast on");
    await vscode.commands.executeCommand("forgepilot.runAgent", TASK_B);
    log("MARK fast off");
    log("Task B diff --stat:\n" + sh("git status --short") + sh("git diff --stat"));
    const vB1 = sh("python -m pytest tests/test_cli.py -q");
    log("Task B pytest:", vB1.split(/\r?\n/).filter(Boolean).slice(-3).join(" | "));
    const vB2 = sh(`python -m flask --app "${APP}" config`);
    log("Task B flask config:", vB2.slice(0, 400));
    const vB3 = sh(`python -m flask --app "${APP}" --help`);
    log("Task B in --help:", /\bconfig\b/.test(vB3));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    show("python -m pytest tests/test_cli.py -q");
    await sleep(14000);
    show(`python -m flask --app "${APP}" config`);
    await sleep(5000);
    show(`python -m flask --app "${APP}" --help | Select-String "config|routes|run|shell"`);
    await sleep(4000);
    show("git add -N .; git diff --stat");
    await sleep(4000);
    await vscode.commands.executeCommand("simpleBrowser.show", "http://localhost:8790");
    await sleep(9000);
    // keep Task B's result, so Task C starts from a clean tree
    sh("git add -A"); sh('git commit -q -m "Task B: flask config command (ForgePilot)"');
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");

    }
    // ---------------- Task C: resilience ----------------
    if (ONLY.includes("C")) {
    await setModels(BROKEN_FIRST);
    await vscode.commands.executeCommand("forgepilot._demoPolicy", { action: "reject", delayMs: 4000 });
    show("git status --short; Write-Output 'git status: clean before Task C'");
    await sleep(3000);
    await selectFunction("src/flask/helpers.py", "get_debug_flag");
    await sleep(2000);
    log("MARK fast on");
    await vscode.commands.executeCommand("forgepilot.inlineEdit", { instruction: TASK_A });
    log("MARK fast off");
    show("git status --short; Write-Output '--- git status after Task C (empty = no files changed)'");
    log("Task C git status:", JSON.stringify(sh("git status --short")));
    await sleep(5000);
    await vscode.commands.executeCommand("forgepilot._demoPolicy", null);
    await setModels(PRIMARY);
    }
    log("DEMO COMPLETE");
  } catch (e) {
    log("DEMO ERROR", e && e.stack || e);
  }
  await sleep(4000);
}

module.exports = { run };
