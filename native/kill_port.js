#!/usr/bin/env node
// Native messaging host for the Localhost Dashboard extension.
// Chrome/Edge launch this on demand. Two requests:
//   { "port": <n> }        kill whatever listens on that TCP port -> { ok, killed:[pids] } | { ok:false, error }
//   { "type": "sessions" } recent AI coding sessions (see sessions.js) -> { ok, sessions:[…], errors }
//   { "type": "focus", "app": "Ghostty" [, "path": dir] } bring an app to the front -> { ok } | { ok:false, error }
//   { "type": "ports", "ports": [n…] } who listens on each port -> { ok, ports: { n: { pid, name, cwd, cmd } } }
//
// Native messaging framing: each message is a 4-byte little-endian length
// followed by that many bytes of UTF-8 JSON, on stdin (request) / stdout (reply).
"use strict";
const { execSync, execFileSync } = require("child_process");
const fs = require("fs");
const { recentSessions } = require("./sessions");
const { healthSummary } = require("./health");

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function killPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `invalid port: ${port}` };
  }
  let out = "";
  try {
    // PIDs of processes listening on this TCP port.
    out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // lsof exits non-zero when it finds nothing.
    return { ok: false, error: `nothing listening on :${port}` };
  }
  const pids = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!pids.length) return { ok: false, error: `nothing listening on :${port}` };

  const killed = [];
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGTERM");
      killed.push(pid);
    } catch (e) {
      return { ok: false, error: `kill ${pid} failed: ${e.message}` };
    }
  }
  return { ok: true, killed };
}

// Process info for the given listening TCP ports: one lsof for all listeners,
// then cwd + full command line per distinct pid.
function portsInfo(ports) {
  const want = new Set((Array.isArray(ports) ? ports : []).map(Number).filter((p) => p > 0 && p < 65536));
  const byPort = {};
  let out = "";
  try {
    out = execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
    });
  } catch (e) {
    out = e.stdout || "";
  }
  let pid = 0, name = "";
  for (const line of out.split("\n")) {
    const tag = line[0], val = line.slice(1);
    if (tag === "p") pid = Number(val);
    else if (tag === "c") name = val;
    else if (tag === "n") {
      const port = Number(val.split(":").pop());
      if (want.has(port) && !byPort[port]) byPort[port] = { pid, name };
    }
  }
  const pidInfo = {};
  for (const info of Object.values(byPort)) {
    if (!pidInfo[info.pid]) {
      const pi = (pidInfo[info.pid] = {});
      try {
        const cwd = execFileSync("/usr/sbin/lsof", ["-a", "-p", String(info.pid), "-d", "cwd", "-Fn"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
        });
        pi.cwd = cwd.split("\n").find((l) => l[0] === "n")?.slice(1) || "";
      } catch {}
      try {
        pi.cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(info.pid)], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000,
        }).trim().slice(0, 300);
      } catch {}
    }
    Object.assign(info, pidInfo[info.pid]);
  }
  return { ok: true, ports: byPort };
}

// Parse framed messages off stdin. With chrome.runtime.sendNativeMessage,
// Chrome starts a fresh process, sends one message, and expects one reply.
// Apps the dashboard may bring to the front (never an arbitrary app name).
const FOCUSABLE = new Set(["Ghostty", "Claude", "Cursor"]);

function focusApp(app, dir) {
  if (!FOCUSABLE.has(app)) return { ok: false, error: `not allowed: ${app}` };
  // Cursor also takes a folder, which focuses (or opens) that project's window.
  const args = ["-a", app];
  if (app === "Cursor" && typeof dir === "string" && dir.startsWith("/") &&
      fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    args.push(dir);
  }
  try {
    execFileSync("/usr/bin/open", args, { stdio: "ignore", timeout: 5000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `couldn't open ${app}` };
  }
}

// Title + icon of a web page, for link chips pasted into the notes. Fetched here
// (not by the extension) so the extension needs no permission to read every site.
async function pageTitle(raw) {
  let url;
  try { url = new URL(raw); } catch { return { ok: false, error: "bad url" }; }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, error: "only http(s)" };
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(7000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      "Accept-Language": "en,de;q=0.8",
    },
  });
  const final = new URL(res.url || url);
  const type = res.headers.get("content-type") || "";
  let html = "";
  if (/html|xml/i.test(type)) {
    // the <head> is enough; stop after ~600 KB
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (html.length < 600000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
  }
  const decode = (t) => t
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  const meta = (name) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    return tag?.match(/content=["']([^"']*)["']/i)?.[1];
  };
  const title = decode(meta("og:title") || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const iconHref = html.match(/<link[^>]+rel=["'][^"']*\bicon\b[^"']*["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1];
  let icon = null;
  try { icon = new URL(iconHref ? decode(iconHref) : "/favicon.ico", final).href; } catch {}
  return { ok: true, url: final.href, title: title.slice(0, 200), icon, site: final.hostname.replace(/^www\./, "") };
}

// Daily notes mirrored as Markdown files (~/notes/YYYY-MM-DD.md) so other tools
// (e.g. Claude Code) can read them. Only non-empty notes get a file; clearing a
// note removes its file. Written atomically (temp file + rename).
const NOTES_DIR = require("path").join(require("os").homedir(), "notes");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function writeNote(date, text) {
  if (!DAY_RE.test(date || "")) return { ok: false, error: "bad date" };
  const path = require("path").join(NOTES_DIR, `${date}.md`);
  const body = String(text ?? "");
  if (!body.trim()) {
    if (fs.existsSync(path)) fs.unlinkSync(path);
    return { ok: true, removed: true };
  }
  const out = body.endsWith("\n") ? body : body + "\n";
  if (fs.existsSync(path) && fs.readFileSync(path, "utf8") === out) return { ok: true, unchanged: true };
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, path);
  return { ok: true, path };
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const body = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    let req = {};
    try {
      req = JSON.parse(body.toString("utf8"));
    } catch {
      send({ ok: false, error: "bad JSON" });
      continue;
    }
    if (req.type === "focus") {
      send(focusApp(req.app, req.path));
    } else if (req.type === "ports") {
      try { send(portsInfo(req.ports)); }
      catch (e) { send({ ok: false, error: String(e.message || e) }); }
    } else if (req.type === "note-save") {
      try { send(writeNote(req.date, req.text)); }
      catch (e) { send({ ok: false, error: String(e.message || e) }); }
    } else if (req.type === "notes-sync") {
      // one-time backfill: write every non-empty stored note (never deletes files)
      try {
        let written = 0;
        for (const [date, text] of Object.entries(req.notes || {})) {
          if (String(text || "").trim() && writeNote(date, text).path) written++;
        }
        send({ ok: true, written, dir: NOTES_DIR });
      } catch (e) { send({ ok: false, error: String(e.message || e) }); }
    } else if (req.type === "title") {
      pending++;
      pageTitle(req.url)
        .then(send, (e) => send({ ok: false, error: String(e.message || e) }))
        .finally(() => { if (--pending === 0 && ended) process.exit(0); });
    } else if (req.type === "health") {
      try { send(healthSummary(Number(req.days) || 7)); }
      catch (e) { send({ ok: false, error: String(e.message || e) }); }
    } else if (req.type === "sessions") {
      try { send(recentSessions(Number(req.limit) || 7)); }
      catch (e) { send({ ok: false, error: String(e.message || e) }); }
    } else {
      send(killPort(Number(req.port)));
    }
  }
});
// Async requests (page titles) keep the host alive until they've answered.
let pending = 0, ended = false;
process.stdin.on("end", () => { ended = true; if (!pending) process.exit(0); });
