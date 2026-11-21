// MCP server exposing the editor's capabilities to the TrueForge agent.
// The agent (not the extension) decides what to read, search, edit and run.
// edit_file / create_file / run_command are approval-gated in TrueForge, so they only
// execute after the user accepted the change in the diff review.
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const vscode = require("vscode");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const EXCLUDE = "**/{.git,node_modules,.venv,venv,__pycache__,.mypy_cache,.pytest_cache,dist,build,.tox}/**";
const TEXT_EXT = /\.(py|pyi|rst|md|txt|toml|cfg|ini|json|ya?ml|js|ts|html|css|sh)$/i;

function root() {
  const f = vscode.workspace.workspaceFolders;
  if (!f || !f.length) throw new Error("Open a folder in VS Code first.");
  // VS Code reports Windows paths with a lower-case drive ("c:\..."). Commands run from there see
  // __file__ and sys.path with "c:" while Python itself uses "C:", which breaks path-comparing tests.
  return f[0].uri.fsPath.replace(/^([a-z]):/, (m, d) => d.toUpperCase() + ":");
}

function resolveInside(rel) {
  const r = root();
  const abs = path.resolve(r, rel);
  if (abs !== r && !abs.startsWith(r + path.sep)) throw new Error(`Path is outside the workspace: ${rel}`);
  return abs;
}

function relPath(abs) {
  return path.relative(root(), abs).split(path.sep).join("/");
}

async function readText(abs) {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === abs);
  if (open) return open.getText();
  return fs.promises.readFile(abs, "utf8");
}

async function listFiles(glob, limit = 3000) {
  const uris = await vscode.workspace.findFiles(glob || "**/*", EXCLUDE, limit);
  return uris.map((u) => relPath(u.fsPath)).sort();
}

function editKey(p, oldS, newS) {
  return crypto.createHash("sha1").update(`${p}\0${oldS}\0${newS}`).digest("hex");
}

class WorkspaceTools {
  constructor(log, events) {
    this.log = log; // (kind, text) => void
    this.events = events; // { onApply(file, before, after) }
    this.decisions = new Map(); // editKey -> { acceptedText } set by the diff review
    this.children = new Set();
    this.token = crypto.randomBytes(24).toString("hex");
    this.server = null;
    this.port = 0;
  }

  // ---- decisions from the diff review -------------------------------------------------
  setDecision(key, acceptedText) { this.decisions.set(key, { acceptedText }); }
  static keyFor(p, oldS, newS) { return editKey(p, oldS, newS); }

  cancelAll() {
    for (const c of this.children) { try { c.kill(); } catch { /* already gone */ } }
    this.children.clear();
    this.decisions.clear();
  }

  // ---- the MCP server -----------------------------------------------------------------
  build() {
    const s = new McpServer({ name: "vscode-workspace", version: "0.1.0" });
    const text = (t) => ({ content: [{ type: "text", text: t }] });

    s.registerTool("list_files", {
      description: "List workspace files matching a glob (default all). Use to explore the repository layout.",
      inputSchema: { glob: z.string().optional().describe("e.g. src/**/*.py") },
      annotations: { readOnlyHint: true },
    }, async ({ glob }) => {
      const files = await listFiles(glob);
      this.log("tool", `list_files ${glob || "**/*"} -> ${files.length} files`);
      return text(files.slice(0, 400).join("\n") + (files.length > 400 ? `\n... ${files.length - 400} more` : ""));
    });

    s.registerTool("search_code", {
      description: "Search file contents for a regular expression (case-insensitive). Returns path:line: text hits. Use it to find where things are defined and used.",
      inputSchema: { pattern: z.string(), glob: z.string().optional(), max_results: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    }, async ({ pattern, glob, max_results }) => {
      let re;
      try { re = new RegExp(pattern, "i"); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      const files = (await listFiles(glob || "**/*")).filter((f) => TEXT_EXT.test(f));
      const hits = [];
      const limit = Math.min(max_results || 60, 200);
      for (const f of files) {
        let body;
        try { body = await readText(resolveInside(f)); } catch { continue; }
        const lines = body.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (re.test(lines[i])) hits.push(`${f}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
        if (hits.length >= limit) break;
      }
      this.log("tool", `search_code /${pattern}/ -> ${hits.length} hits in ${new Set(hits.map((h) => h.split(":")[0])).size} files`);
      return text(hits.join("\n") || "No matches.");
    });

    s.registerTool("get_symbols", {
      description: "List classes and functions defined in a file, with line numbers.",
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true },
    }, async ({ path: p }) => {
      const body = await readText(resolveInside(p));
      const out = [];
      body.split(/\r?\n/).forEach((l, i) => {
        const m = l.match(/^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/) || l.match(/^(\s*)(export\s+)?(function|class)\s+([A-Za-z_]\w*)/);
        if (m) out.push(`${i + 1}: ${l.trim().slice(0, 160)}`);
      });
      this.log("tool", `get_symbols ${p} -> ${out.length}`);
      return text(out.join("\n") || "No symbols found.");
    });

    s.registerTool("read_file", {
      description: "Read a file (or a line range) with line numbers. Read a file before editing it.",
      inputSchema: { path: z.string(), start_line: z.number().int().optional(), end_line: z.number().int().optional() },
      annotations: { readOnlyHint: true },
    }, async ({ path: p, start_line, end_line }) => {
      const body = await readText(resolveInside(p));
      const lines = body.split(/\r?\n/);
      const a = Math.max(1, start_line || 1);
      const b = Math.min(lines.length, end_line || Math.min(lines.length, a + 399));
      this.log("tool", `read_file ${p}:${a}-${b}`);
      return text(lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join("\n") + (b < lines.length ? `\n... (${lines.length} lines total)` : ""));
    });

    s.registerTool("edit_file", {
      description: "Replace old_string with new_string in an existing file. old_string must match the file exactly (including indentation) and be unique; include enough surrounding lines. The user reviews every change hunk by hunk before it is written.",
      inputSchema: { path: z.string(), old_string: z.string(), new_string: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ path: p, old_string, new_string }) => this.applyReviewed(p, old_string, new_string, false));

    s.registerTool("create_file", {
      description: "Create a new file with the given content. The user reviews it before it is written.",
      inputSchema: { path: z.string(), content: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, async ({ path: p, content }) => this.applyReviewed(p, "", content, true));

    s.registerTool("run_command", {
      description: "Run a shell command in the workspace root (for example tests). Returns exit code and the last part of the output. Needs user approval.",
      inputSchema: { command: z.string(), timeout_sec: z.number().int().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, async ({ command, timeout_sec }) => text(await this.runCommand(command, timeout_sec)));

    return s;
  }

  async applyReviewed(p, oldS, newS, isCreate) {
    const key = editKey(p, oldS, newS);
    if (process.env.FORGEPILOT_TRACE) fs.appendFileSync(process.env.FORGEPILOT_TRACE, `MCP ${key} ${JSON.stringify({ p, oldS, newS })}\nKNOWN ${[...this.decisions.keys()].join(",")}\n`);
    const decision = this.decisions.get(key);
    this.decisions.delete(key);
    if (!decision) {
      return { content: [{ type: "text", text: "Not applied: this change was not approved in the diff review." }], isError: true };
    }
    const abs = resolveInside(p);
    const before = isCreate ? "" : await readText(abs);
    const after = decision.acceptedText;
    if (after === before) return { content: [{ type: "text", text: "No hunks accepted; file unchanged." }] };
    const uri = vscode.Uri.file(abs);
    if (isCreate) {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, after, "utf8");
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), after);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    }
    this.events.onApply(p, before, after, isCreate);
    this.log("apply", `${isCreate ? "created" : "updated"} ${p}`);
    const partial = decision.partial ? " (only the hunks the user accepted)" : "";
    return { content: [{ type: "text", text: `Applied to ${p}${partial}.` }] };
  }

  runCommand(command, timeoutSec) {
    const timeout = Math.min(Math.max(timeoutSec || 120, 5), 300) * 1000;
    this.log("tool", `run_command: ${command}`);
    return new Promise((resolve) => {
      const extra = vscode.workspace.getConfiguration("forgepilot").get("commandPathPrepend") || "";
      const env = { ...process.env };
      if (extra) {
        const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
        env[key] = `${extra}${path.delimiter}${env[key] || ""}`;
      }
      const child = spawn(command, { cwd: root(), shell: true, windowsHide: true, env });
      this.children.add(child);
      let out = "";
      const add = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-100000); };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeout);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        this.children.delete(child);
        const tail = out.length > 6000 ? "...\n" + out.slice(-6000) : out;
        resolve(`exit code: ${code === null ? `killed (${signal || "timeout/cancel"})` : code}\n${tail}`);
      });
      child.on("error", (e) => { clearTimeout(timer); this.children.delete(child); resolve(`failed to start: ${e.message}`); });
    });
  }

  async start(port) {
    if (this.server) return;
    this.server = http.createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.token}`) { res.writeHead(401).end(); return; }
      if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body;
      try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
      const server = this.build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { transport.close(); server.close(); });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        this.log("error", `MCP request failed: ${e.message}`);
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
    await new Promise((ok, fail) => { this.server.once("error", fail); this.server.listen(port, "127.0.0.1", ok); });
    this.port = port;
  }

  url() { return `http://127.0.0.1:${this.port}/mcp`; }

  stop() { if (this.server) { this.server.close(); this.server = null; } }
}

module.exports = { WorkspaceTools, listFiles, readText, resolveInside, relPath, root, TEXT_EXT };
