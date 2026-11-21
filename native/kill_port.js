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
process.stdin.on("end", () => process.exit(0));
