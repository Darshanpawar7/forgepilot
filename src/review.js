// Diff review: every proposed change is shown in VS Code's diff editor and the user accepts
// or rejects it hunk by hunk. Only the accepted hunks are ever written (see workspaceTools).
const vscode = require("vscode");
const Diff = require("diff");

const SCHEME = "forgepilot";
const docs = new Map();
let seq = 0;

// Scripted demos (recording the video) set a policy instead of a person clicking:
// { action: "accept" | "reject", delayMs }. null = interactive (normal use).
let demoPolicy = null;
function setDemoPolicy(p) { demoPolicy = p; }

class Provider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChange = this.emitter.event; }
  provideTextDocumentContent(uri) { return docs.get(uri.path) || ""; }
}

function register(context) {
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, new Provider()));
}

function virtualUri(label, body) {
  const p = `/${++seq}/${label}`;
  docs.set(p, body);
  return vscode.Uri.from({ scheme: SCHEME, path: p });
}

function pickHunks(items, title) {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.title = title;
    qp.placeholder = "Space toggles a hunk · Enter applies the ticked hunks · Esc rejects all";
    qp.items = items;
    qp.selectedItems = items;
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); qp.hide(); } };
    qp.onDidAccept(() => finish([...qp.selectedItems]));
    qp.onDidHide(() => finish(null));
    qp.show();
    if (demoPolicy) setTimeout(() => finish(demoPolicy.action === "accept" ? [...qp.selectedItems] : null), demoPolicy.delayMs || 4000);
  });
}

// Returns { allow, acceptedText, partial, reason }
async function review({ path: file, before, after, isCreate, title }) {
  const patch = Diff.structuredPatch(file, file, before, after, "", "", { context: 3 });
  const hunks = patch.hunks;
  if (!hunks.length) return { allow: false, reason: "The proposed change does not change the file." };

  const left = virtualUri(`${file} (current)`, before);
  const right = virtualUri(`${file} (proposed)`, after);
  await vscode.commands.executeCommand("vscode.diff", left, right, `${title || "ForgePilot"}: ${file}${isCreate ? " (new file)" : ""} · proposed, not yet written`, { preview: false });

  const items = hunks.map((h, i) => {
    const added = h.lines.filter((l) => l.startsWith("+")).length;
    const removed = h.lines.filter((l) => l.startsWith("-")).length;
    const first = (h.lines.find((l) => l.startsWith("+") || l.startsWith("-")) || "").slice(0, 90);
    return { label: `Hunk ${i + 1}  @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, description: `+${added} -${removed}`, detail: first, index: i };
  });

  const picked = await pickHunks(items, `Review ${hunks.length} hunk${hunks.length > 1 ? "s" : ""} in ${file}: tick to apply, untick to reject`);

  if (!picked || !picked.length) {
    const reason = demoPolicy ? "" : await vscode.window.showInputBox({ prompt: "Optional: why did you reject it? (sent back to the agent)", ignoreFocusOut: true });
    return { allow: false, reason: `The user rejected this change to ${file}.${reason ? " Reason: " + reason : ""} Do not retry it; stop and summarise.` };
  }
  if (picked.length === hunks.length) return { allow: true, acceptedText: after, partial: false };

  const keep = new Set(picked.map((p) => p.index));
  const subset = { ...patch, hunks: hunks.filter((_, i) => keep.has(i)) };
  const partialText = Diff.applyPatch(before, subset);
  if (partialText === false) {
    vscode.window.showWarningMessage("ForgePilot could not apply only some hunks; nothing was applied. Accept all hunks or reject.");
    return { allow: false, reason: `The user accepted only some hunks of ${file}, and they could not be applied separately. Propose a smaller change.` };
  }
  return { allow: true, acceptedText: partialText, partial: true };
}

module.exports = { register, review, setDemoPolicy, getDemoPolicy: () => demoPolicy };
