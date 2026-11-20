// Context assembly: what the model sees before it starts using tools.
// 1. Explicit mentions: @path/to/file and @symbol are resolved and included first.
// 2. Automatic retrieval: keywords from the request rank files (path hits + content hits,
//    weighted by how rare each keyword is), then the best snippets are packed into a fixed
//    character budget, plus a compact repository map (paths + top-level symbols).
// Everything chosen, and why, is reported to the panel so the user can see it.
const { listFiles, readText, resolveInside, TEXT_EXT } = require("./workspaceTools");

const STOP = new Set(("the a an and or of to in on for with as is are be by it its this that from into must should " +
  "add new make use using any all also each same like alongside other value values key keys file files code").split(" "));

function keywords(request) {
  const words = request.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [];
  const out = [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    if (!out.includes(w)) out.push(w);
    for (const part of w.split("_")) if (part.length > 2 && !STOP.has(part) && !out.includes(part)) out.push(part);
  }
  return out.slice(0, 20);
}

async function resolveMentions(request, files) {
  const picked = [];
  for (const m of request.matchAll(/@([\w./-]+)/g)) {
    const token = m[1];
    const file = files.find((f) => f === token || f.endsWith("/" + token));
    if (file) { picked.push({ kind: "file", name: file }); continue; }
    picked.push({ kind: "symbol", name: token });
  }
  return picked;
}

async function symbolSnippet(name, files) {
  const re = new RegExp(`^\\s*(async\\s+def|def|class)\\s+${name.replace(/[^\w]/g, "")}\\b`);
  for (const f of files.filter((x) => x.endsWith(".py"))) {
    let body;
    try { body = await readText(resolveInside(f)); } catch { continue; }
    const lines = body.split(/\r?\n/);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return { file: f, start: i + 1, text: lines.slice(i, i + 40).map((l, k) => `${i + 1 + k}\t${l}`).join("\n") };
  }
  return null;
}

async function assemble(request, { budgetChars = 24000, extra = "" } = {}) {
  const files = (await listFiles("**/*")).filter((f) => TEXT_EXT.test(f));
  const report = [];
  const parts = [];
  let used = 0;
  const push = (title, body, why) => {
    const chunk = `### ${title}\n${body}\n`;
    if (used + chunk.length > budgetChars) return false;
    parts.push(chunk); used += chunk.length; report.push(`${title} (${why})`); return true;
  };

  if (extra) push("Selection", extra, "the code you selected");

  // 1) explicit mentions
  for (const m of await resolveMentions(request, files)) {
    if (m.kind === "file") {
      const body = await readText(resolveInside(m.name));
      push(m.name, body.split(/\r?\n/).slice(0, 300).map((l, i) => `${i + 1}\t${l}`).join("\n"), "you mentioned it with @");
    } else {
      const s = await symbolSnippet(m.name, files);
      if (s) push(`${s.file}:${s.start} (${m.name})`, s.text, `you mentioned @${m.name}`);
    }
  }

  // 2) automatic retrieval
  const kws = keywords(request);
  const df = new Map(kws.map((k) => [k, 0]));
  const perFile = [];
  for (const f of files) {
    let body;
    try { body = await readText(resolveInside(f)); } catch { continue; }
    const lower = body.toLowerCase();
    const hits = {};
    for (const k of kws) {
      const n = lower.split(k).length - 1;
      if (n) { hits[k] = n; df.set(k, df.get(k) + 1); }
    }
    if (Object.keys(hits).length) perFile.push({ f, body, hits });
  }
  const idf = (k) => Math.log(1 + files.length / (1 + df.get(k)));
  for (const p of perFile) {
    let score = 0;
    for (const [k, n] of Object.entries(p.hits)) score += idf(k) * (1 + Math.log(n));
    for (const k of kws) if (p.f.toLowerCase().includes(k)) score += 2 * idf(k);
    if (/(^|\/)tests?\//.test(p.f)) score *= 0.9;
    // Changelogs mention every feature name, so they match almost any request; rank them below code.
    if (/(^|\/)(CHANGES|CHANGELOG|HISTORY|NEWS)(\.\w+)?$/i.test(p.f)) score *= 0.4;
    p.score = score;
  }
  perFile.sort((a, b) => b.score - a.score);
  const top = perFile.slice(0, 8);

  // compact map of the most relevant files: path + top-level symbols
  const map = top.map((p) => {
    const syms = p.body.split(/\r?\n/).map((l, i) => [l, i]).filter(([l]) => /^(class|def|async def)\s/.test(l))
      .slice(0, 12).map(([l, i]) => `${i + 1}:${l.replace(/\(.*$/, "").replace(/^(async def|def|class)\s+/, "")}`);
    return `- ${p.f} [score ${p.score.toFixed(1)}; matched: ${Object.keys(p.hits).slice(0, 5).join(", ")}]  ${syms.join(", ")}`;
  }).join("\n");
  if (map) push("Most relevant files (automatic retrieval)", map, "ranked by keyword relevance");

  // snippets around the best hits in the top files
  for (const p of top.slice(0, 5)) {
    const lines = p.body.split(/\r?\n/);
    const strong = kws.filter((k) => p.hits[k]).sort((a, b) => idf(b) - idf(a)).slice(0, 2);
    const idx = lines.findIndex((l) => strong.some((k) => l.toLowerCase().includes(k)));
    if (idx < 0) continue;
    const a = Math.max(0, idx - 6), b = Math.min(lines.length, idx + 30);
    if (!push(`${p.f}:${a + 1}-${b}`, lines.slice(a, b).map((l, i) => `${a + 1 + i}\t${l}`).join("\n"), `best hit for "${strong.join('", "')}"`)) break;
  }

  return {
    text: `## Context pack (budget ${budgetChars} chars, used ${used})\n` +
      `Keywords: ${kws.join(", ")}\n\n${parts.join("\n")}`,
    report, used, budgetChars, keywords: kws,
  };
}

module.exports = { assemble, keywords };
