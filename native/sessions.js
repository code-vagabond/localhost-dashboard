// Recent AI coding sessions, read from each tool's local history files.
// Used by the native host for { "type": "sessions" } requests.
//
// Sources (all local, read-only):
//   Claude Code     ~/.claude/projects/<project>/<session>.jsonl
//   Claude Desktop  Code tab: same jsonl files, flagged via Desktop's session index
//                   Cowork:   ~/Library/Application Support/Claude/local-agent-mode-sessions/**/local_*.json
//                   (regular Desktop chats live in the cloud — not readable locally)
//   Codex           ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (+ session_index.jsonl for titles)
//   Cursor CLI      ~/.cursor/chats/<workspace>/<chat>/meta.json + prompt_history.json
//   Cursor app      Cursor's state.vscdb (sqlite, composerData + bubbleId rows)
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = os.homedir();
const CLAUDE_APP = path.join(HOME, "Library/Application Support/Claude");
const CURSOR_DB = path.join(HOME, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
const PER_SOURCE = 12; // candidates parsed per tool before the global merge

// --- small helpers ---
function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function mtime(file) {
  return safe(() => fs.statSync(file).mtimeMs, 0);
}
// Files matching `test` directly inside each subdirectory of `dir` (one level deep).
function filesOneDown(dir, test) {
  const out = [];
  for (const sub of safe(() => fs.readdirSync(dir), [])) {
    const subDir = path.join(dir, sub);
    for (const f of safe(() => fs.readdirSync(subDir), [])) {
      if (test(f)) out.push(path.join(subDir, f));
    }
  }
  return out;
}
function newest(files, n, when = mtime) {
  return files
    .map((file) => ({ file, at: when(file) }))
    .sort((a, b) => b.at - a.at)
    .slice(0, n);
}
// Last "timestamp" written in a .jsonl log — the real last activity. File mtimes
// get bumped by tools that merely touch old logs, so they can't be trusted alone.
function lastLogTime(file) {
  return safe(() => {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const stamps = buf.toString("utf8").match(/"timestamp":"([^"]+)"/g);
      const last = stamps && stamps[stamps.length - 1].slice(13, -1);
      return (last && Date.parse(last)) || mtime(file);
    } finally {
      fs.closeSync(fd);
    }
  }, 0);
}
function eachJsonLine(file, fn) {
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (fn(d) === false) break;
  }
}
// Collapse whitespace and cap length — this is a one-line preview, not the transcript.
function clip(s, n = 280) {
  s = String(s || "")
    .replace(/<\/?[a-z][\w-]*(\s[^>]*)?>/gi, " ") // harness tags like <pasted_content id="…">
    .replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
// Prompts that are harness plumbing rather than something the user typed.
function isNoise(text) {
  const t = String(text || "").trim();
  return !t || t.startsWith("<") || t.startsWith("# AGENTS.md") || t.startsWith("/") || t.startsWith("Caveat:");
}
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// --- Claude Code (terminal + Claude Desktop's Code tab) ---
function claudeCode() {
  // Session ids that Claude Desktop started, so they can be labelled as Desktop.
  const desktopIds = new Set();
  for (const f of filesOneDown(path.join(CLAUDE_APP, "claude-code-sessions"), () => true)) {
    // layout: claude-code-sessions/<account>/<org>/local_<id>.json
    for (const g of safe(() => fs.readdirSync(f), [])) {
      if (!g.endsWith(".json")) continue;
      const id = safe(() => readJson(path.join(f, g)).cliSessionId, null);
      if (id) desktopIds.add(id);
    }
  }

  const files = filesOneDown(path.join(HOME, ".claude/projects"), (f) => f.endsWith(".jsonl"));
  const out = [];
  for (const { file, at } of newest(files, PER_SOURCE * 2, lastLogTime)) {
    let title = "", query = "", cwd = "", entry = "";
    eachJsonLine(file, (d) => {
      if (d.entrypoint && !entry) entry = d.entrypoint;
      if (d.cwd && !cwd) cwd = d.cwd;
      if (d.type === "custom-title" && d.customTitle) title = d.customTitle;
      else if (d.type === "ai-title" && d.aiTitle && !title) title = d.aiTitle;
      else if (d.type === "summary" && d.summary && !title) title = d.summary;
      if (!query && d.type === "user" && !d.isMeta && !d.isSidechain) {
        const c = d.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.find((p) => p.type === "text")?.text : "";
        if (!isNoise(text)) query = text;
      }
    });
    if (!query) continue;                 // empty / aborted session
    if (entry.startsWith("sdk")) continue; // `claude -p` automation runs, not sessions
    const id = path.basename(file, ".jsonl");
    const desktop = desktopIds.has(id);
    out.push({
      tool: desktop ? "claude-desktop" : "claude-code",
      id, title, query: clip(query), cwd, updatedAt: at,
      resume: desktop ? "" : `cd ${shellQuote(cwd || HOME)} && claude --resume ${id}`,
    });
  }
  return out;
}

// --- Claude Desktop Cowork sessions ---
function claudeCowork() {
  const root = path.join(CLAUDE_APP, "local-agent-mode-sessions");
  const files = [];
  // layout: local-agent-mode-sessions/<account>/<org>/local_<id>.json
  for (const dir of filesOneDown(root, () => true)) {
    for (const f of safe(() => fs.readdirSync(dir), [])) {
      if (f.startsWith("local_") && f.endsWith(".json")) files.push(path.join(dir, f));
    }
  }
  const out = [];
  for (const { file, at } of newest(files, PER_SOURCE)) {
    const d = safe(() => readJson(file), null);
    if (!d || d.isArchived === true || !d.initialMessage) continue;
    out.push({
      tool: "claude-desktop",
      id: d.cliSessionId || d.sessionId,
      title: d.title || "Cowork",
      query: clip(d.initialMessage),
      cwd: "",
      updatedAt: Number(d.lastActivityAt) || at,
      resume: "",
    });
  }
  return out;
}

// --- Codex CLI ---
function codex() {
  const root = path.join(HOME, ".codex/sessions");
  // Thread names Codex generates, keyed by session id (later lines win).
  const names = {};
  safe(() => eachJsonLine(path.join(HOME, ".codex/session_index.jsonl"), (d) => {
    if (d.id && d.thread_name) names[d.id] = d.thread_name;
  }));
  // Walk only the newest day folders: sessions/YYYY/MM/DD.
  const files = [];
  const desc = (dir) => safe(() => fs.readdirSync(dir), []).filter((n) => /^\d+$/.test(n)).sort().reverse();
  outer: for (const y of desc(root)) for (const m of desc(path.join(root, y))) for (const d of desc(path.join(root, y, m))) {
    const dayDir = path.join(root, y, m, d);
    for (const f of safe(() => fs.readdirSync(dayDir), [])) if (f.endsWith(".jsonl")) files.push(path.join(dayDir, f));
    if (files.length >= PER_SOURCE * 2) break outer;
  }
  const out = [];
  for (const { file, at } of newest(files, PER_SOURCE, lastLogTime)) {
    let id = "", cwd = "", query = "";
    eachJsonLine(file, (d) => {
      if (d.type === "session_meta") { id = d.payload?.id || ""; cwd = d.payload?.cwd || ""; }
      const p = d.payload;
      if (d.type === "response_item" && p?.type === "message" && p.role === "user") {
        const text = (p.content || []).find((c) => c.type === "input_text")?.text;
        if (!isNoise(text)) { query = text; return false; }
      }
    });
    if (!query) continue;
    out.push({
      tool: "codex", id, title: names[id] || "", query: clip(query), cwd, updatedAt: at,
      resume: `cd ${shellQuote(cwd || HOME)} && codex resume ${id}`,
    });
  }
  return out;
}

// --- Cursor CLI (cursor-agent) ---
function cursorCli() {
  const metas = filesOneDown(path.join(HOME, ".cursor/chats"), () => true)
    .map((dir) => path.join(dir, "meta.json"));
  const out = [];
  for (const { file } of newest(metas, PER_SOURCE * 2)) {
    const meta = safe(() => readJson(file), null);
    if (!meta || meta.isSubagent || !meta.hasConversation) continue;
    // prompt_history.json is newest-first; the first real prompt is the last entry.
    const prompts = safe(() => readJson(path.join(path.dirname(file), "prompt_history.json")), []);
    const query = [...prompts].reverse().find((p) => !isNoise(p)) || "";
    if (!query && !meta.title) continue;
    const id = path.basename(path.dirname(file));
    out.push({
      tool: "cursor-cli", id, title: meta.title || "", query: clip(query),
      cwd: meta.cwd || "", updatedAt: meta.updatedAtMs || mtime(file),
      resume: `cd ${shellQuote(meta.cwd || HOME)} && cursor-agent --resume ${id}`,
    });
  }
  return out;
}

// --- Cursor app (composer / agent chats) ---
function sqlite(db, sql) {
  const out = execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", db, sql], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 8000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.trim() ? JSON.parse(out) : [];
}
function cursorApp() {
  if (!fs.existsSync(CURSOR_DB)) return [];
  // Alias the table as c: inside json_each, a bare `value` means json_each's own column.
  const rows = sqlite(CURSOR_DB, `
    SELECT json_extract(c.value,'$.composerId') AS id,
           json_extract(c.value,'$.name') AS title,
           json_extract(c.value,'$.lastUpdatedAt') AS updatedAt,
           json_extract(c.value,'$.workspaceIdentifier.uri.fsPath') AS cwd,
           (SELECT json_extract(h.value,'$.bubbleId') FROM json_each(c.value,'$.fullConversationHeadersOnly') h
             WHERE json_extract(h.value,'$.type') = 1 LIMIT 1) AS firstBubble
    FROM cursorDiskKV c
    WHERE c.key LIKE 'composerData:%' AND json_extract(c.value,'$.lastUpdatedAt') IS NOT NULL
    ORDER BY json_extract(c.value,'$.lastUpdatedAt') DESC LIMIT ${PER_SOURCE}`);
  const out = [];
  for (const r of rows) {
    if (!r.firstBubble) continue; // never sent a message
    const key = `bubbleId:${r.id}:${r.firstBubble}`.replace(/'/g, "''");
    const [b] = safe(() => sqlite(CURSOR_DB, `SELECT json_extract(value,'$.text') AS text FROM cursorDiskKV WHERE key='${key}'`), []);
    out.push({
      tool: "cursor-app", id: r.id, title: r.title || "", query: clip(b?.text || ""),
      cwd: r.cwd || "", updatedAt: Number(r.updatedAt) || 0, resume: "",
    });
  }
  return out;
}

// Merge every source, newest first. One broken source never hides the others.
function recentSessions(limit = 7) {
  const sources = { claudeCode, claudeCowork, codex, cursorCli, cursorApp };
  const all = [];
  const errors = {};
  for (const [name, fn] of Object.entries(sources)) {
    try { all.push(...fn()); } catch (e) { errors[name] = String(e.message || e); }
  }
  // Same session can show up twice (e.g. a Cowork session and its Claude Code log).
  const seen = new Set();
  const sessions = all
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((s) => !seen.has(s.id) && seen.add(s.id))
    .slice(0, limit);
  return { ok: true, sessions, errors };
}

module.exports = { recentSessions };

// `node sessions.js` prints the list — handy for checking what the dashboard will show.
if (require.main === module) {
  console.log(JSON.stringify(recentSessions(Number(process.argv[2]) || 7), null, 2));
}
