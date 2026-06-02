const DEFAULT_PORTS =
  "3000-3005, 4000, 4200, 5000, 5173, 5174, 8000, 8080, 8081, 8888, 9000";
const HOST = "http://localhost";
const PROBE_TIMEOUT = 1500; // ms
const TITLE_TIMEOUT = 2500; // ms

const $ = (id) => document.getElementById(id);
const portsInput = $("ports");
const statusEl = $("status");
const gridEl = $("grid");
const emptyEl = $("empty");
let autoTimer = null;

// --- port list parsing: "3000-3003, 5173" -> [3000,3001,3002,3003,5173] ---
function parsePorts(str) {
  const out = new Set();
  for (const chunk of str.split(",")) {
    const part = chunk.trim();
    if (!part) continue;
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
      if (a > b) [a, b] = [b, a];
      for (let p = a; p <= Math.min(b, a + 200); p++) out.add(p);
    } else if (/^\d+$/.test(part)) {
      out.add(parseInt(part, 10));
    }
  }
  return [...out].filter((p) => p > 0 && p < 65536).sort((a, b) => a - b);
}

// Remember the last non-trivial probe failure so we can explain a blank scan
// (e.g. Chrome blocking localhost fetches) instead of just "nothing responded".
let lastProbeError = "";

// --- probe a port: does anything answer? ---
async function probe(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  try {
    await fetch(`${HOST}:${port}/`, {
      method: "GET",
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow",
    });
    return true; // any HTTP response (even 404/500) means something is listening
  } catch (e) {
    // A "Failed to fetch" can mean closed port OR a non-HTTP service refusing.
    // We treat a connection-refused style error as down, but keep the message:
    // if EVERY port fails the same way, it's usually a browser-level block.
    if (e?.name !== "AbortError") lastProbeError = String(e?.message || e);
    return false;
  } finally {
    clearTimeout(t);
  }
}

// --- grab the <title> of a responding port ---
async function fetchTitle(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT);
  try {
    const res = await fetch(`${HOST}:${port}/`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      return `(${ct.split(";")[0] || "non-HTML"})`;
    }
    const html = await res.text();
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? m[1].trim().replace(/\s+/g, " ").slice(0, 120) : "(no <title>)";
  } catch {
    return "(title unavailable)";
  } finally {
    clearTimeout(t);
  }
}

function card(port, title) {
  const url = `${HOST}:${port}/`;
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `
    <div class="card-head">
      <span class="dot up"></span>
      <span class="port">:${port}</span>
      <span class="title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
      <button class="kill" title="Kill the process on this port">✕</button>
    </div>
    <div class="preview">
      <iframe src="${url}" loading="lazy" referrerpolicy="no-referrer"
              sandbox="allow-same-origin allow-scripts allow-forms"></iframe>
      <div class="overlay" hidden>
        <div>Can't embed (X-Frame-Options / CSP).</div>
      </div>
    </div>`;
  // If the iframe never paints (framing blocked), reveal the fallback overlay.
  const frame = el.querySelector("iframe");
  const overlay = el.querySelector(".overlay");
  const preview = el.querySelector(".preview");
  let loaded = false;
  frame.addEventListener("load", () => { loaded = true; overlay.hidden = true; });
  setTimeout(() => { if (!loaded) overlay.hidden = false; }, 3500);

  // Render the iframe at desktop width (1280px) and scale it down to fit the card,
  // so embedded apps show their full desktop layout instead of a responsive view.
  const DESKTOP_W = 1280;
  const fit = () => {
    const w = preview.clientWidth;
    if (w) preview.style.setProperty("--frame-scale", w / DESKTOP_W);
  };
  new ResizeObserver(fit).observe(preview);

  // Click the card header to open the app in the current tab.
  const head = el.querySelector(".card-head");
  head.addEventListener("click", () => { window.location.href = url; });

  // Kill the process holding this port (via the native messaging host).
  el.querySelector(".kill").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm(`Kill the process on port ${port}?`)) return;
    el.classList.add("killing");
    chrome.runtime.sendMessage({ type: "kill", port }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        el.classList.remove("killing");
        const err = chrome.runtime.lastError?.message || res?.error || "failed";
        statusEl.textContent = `:${port} — ${err}`;
        return;
      }
      // Port is dead — drop the card.
      el.remove();
      statusEl.textContent = `Killed :${port} (pid ${res.killed.join(", ")})`;
    });
  });

  return el;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function scan() {
  const ports = parsePorts(portsInput.value || DEFAULT_PORTS);
  chrome.storage?.local.set({ ports: portsInput.value });
  statusEl.textContent = `Scanning ${ports.length} ports…`;
  gridEl.innerHTML = "";
  emptyEl.hidden = true;

  let alive = 0;
  lastProbeError = "";
  // Probe in small concurrent batches to stay snappy.
  const batchSize = 12;
  for (let i = 0; i < ports.length; i += batchSize) {
    const batch = ports.slice(i, i + batchSize);
    const results = await Promise.all(batch.map((p) => probe(p)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j]) {
        alive++;
        const port = batch[j];
        const c = card(port, "loading…");
        gridEl.appendChild(c);
        fetchTitle(port).then((title) => {
          const titleEl = c.querySelector(".title");
          titleEl.textContent = title;
          titleEl.title = title;
        });
      }
    }
    statusEl.textContent = `Scanned ${Math.min(i + batchSize, ports.length)}/${ports.length} · ${alive} up`;
  }
  statusEl.textContent = `${alive} service${alive === 1 ? "" : "s"} up · ${new Date().toLocaleTimeString()}`;
  emptyEl.hidden = alive > 0;
  if (!alive) {
    emptyEl.innerHTML = lastProbeError
      ? `No services responded — every probe failed with: <code>${escapeHtml(lastProbeError)}</code>.<br>` +
        `If that's "Failed to fetch" for all ports, Chrome is likely blocking localhost requests ` +
        `(reload the extension at chrome://extensions and open a fresh tab). Otherwise start a dev server and hit Scan.`
      : "No services responded. Start a dev server and hit Scan.";
  }
}

$("scan").addEventListener("click", scan);
portsInput.addEventListener("keydown", (e) => { if (e.key === "Enter") scan(); });
$("auto").addEventListener("change", (e) => {
  clearInterval(autoTimer);
  if (e.target.checked) autoTimer = setInterval(scan, 10000);
});

// Restore saved port list and run an initial scan.
chrome.storage?.local.get("ports", ({ ports }) => {
  portsInput.value = ports || DEFAULT_PORTS;
  scan();
});
