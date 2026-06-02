#!/usr/bin/env node
// Native messaging host for the Localhost Dashboard extension.
// Chrome launches this on demand, sends { "port": <n> }, we kill whatever is
// listening on that TCP port and reply { ok, killed:[pids] } | { ok:false, error }.
//
// Native messaging framing: each message is a 4-byte little-endian length
// followed by that many bytes of UTF-8 JSON, on stdin (request) / stdout (reply).
"use strict";
const { execSync } = require("child_process");

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

// Parse framed messages off stdin. With chrome.runtime.sendNativeMessage,
// Chrome starts a fresh process, sends one message, and expects one reply.
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
    send(killPort(Number(req.port)));
  }
});
process.stdin.on("end", () => process.exit(0));
