const DEFAULT_PORTS =
  // Common dev-server ports: Node/Next/Rails (3000s), Vite (5173+), Angular (4200),
  // Astro (4321), Storybook (6006), Gradio (7860), Django/Python (8000s), Hugo (1313)…
  "1234, 1313, 2000-2100, 3000-3200, 3300-3310, 3456, 4000-4010, 4200-4210, 4321, " +
  "4400-4410, 5000-5010, 5173-5190, 5500-5510, 6006, 7000-7010, 7860, 8000-8100, " +
  "8443, 8787, 8888-8890, 9000-9010";
const HOST = "http://localhost";
const PROBE_TIMEOUT = 1500; // ms
const TITLE_TIMEOUT = 2500; // ms

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const gridEl = $("grid");
const emptyEl = $("empty");
const countEl = $("count");
const scanBtn = $("scan");
const progressEl = $("progress");
const toastEl = $("toast");
let autoTimer = null;
let scanning = false;     // a scan is in flight
let rescanQueued = false; // another scan was requested meanwhile
let lastScanAt = null;
let lastProcAt = 0;
// Live iframe previews are heavy (each runs the whole app); off unless enabled in Settings.
let showPreviews = false;
// Port list lives in extension storage and is edited on the Settings page.
let portsConfig = DEFAULT_PORTS;
// Last scan result, so a new tab shows the servers instantly and re-checks quietly.
const CACHE_KEY = "devCache";
const CACHE_FRESH = 30 * 1000; // a tab opened within 30s of the last scan doesn't rescan
let saveTimer = null;

// --- port list parsing: "3000-3003, 5173" -> [3000,3001,3002,3003,5173] ---
function parsePorts(str) {
  const out = new Set();
  for (const chunk of str.split(/[,\n]/)) {
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

// One fetch attempt against a port. Resolves { ok } — ok:true means *something*
// answered (even 404/500 counts as "listening").
async function probeOnce(port) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  try {
    await fetch(`${HOST}:${port}/`, {
      method: "GET",
      signal: ctrl.signal,
      cache: "no-store",
      redirect: "follow",
    });
    return { ok: true };
  } catch (e) {
    // "Failed to fetch" = closed port OR a transient hiccup; AbortError = timeout.
    return { ok: false, error: e };
  } finally {
    clearTimeout(t);
  }
}

// --- probe a port, with retries ---
// A live dev server can drop or stall a single request — cold start, mid-compile,
// or just momentary load when 12 probes fire at once — so one failure isn't proof
// the port is down. Retry a few times before giving up. A genuinely closed port
// fails fast (connection refused), so retrying it costs almost nothing.
async function probe(port) {
  const ATTEMPTS = 3;
  for (let i = 0; i < ATTEMPTS; i++) {
    const r = await probeOnce(port);
    if (r.ok) return true;
    // Keep the message so a fully-blank scan can explain itself (e.g. Chrome
    // blocking localhost). Ignore plain timeouts here — those just mean "retry".
    if (r.error?.name !== "AbortError") lastProbeError = String(r.error?.message || r.error);
    if (i < ATTEMPTS - 1) await new Promise((res) => setTimeout(res, 200 * (i + 1)));
  }
  return false;
}

// --- read a responding port's page once: title, description, favicon, framework ---
// One GET per live port per scan (no rendering, no scripts) — the light alternative
// to a live preview.
const FRAMEWORK_MARKERS = [
  [/\/@vite\/client/, "Vite"],
  [/__NEXT_DATA__|\/_next\//, "Next.js"],
  [/\/_nuxt\//, "Nuxt"],
  [/data-sveltekit|\/_app\/immutable\//, "SvelteKit"],
  [/\/_astro\/|data-astro-cid/, "Astro"],
  [/storybook/i, "Storybook"],
  [/gradio/i, "Gradio"],
  [/jupyter/i, "Jupyter"],
  [/\/static\/js\/bundle\.js/, "Create React App"],
  [/ng-version=|<app-root/, "Angular"],
  [/__remixContext|__reactRouterContext/, "Remix"],
];
const HEADER_MARKERS = [
  [/next\.js/i, "Next.js"], [/express/i, "Express"], [/uvicorn/i, "Uvicorn"],
  [/werkzeug/i, "Flask"], [/wsgiserver/i, "Django"], [/hugo/i, "Hugo"],
];
const attr = (tag, name) =>
  tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(2).find((x) => x != null);
const decode = (s) => {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value.trim().replace(/\s+/g, " ");
};

async function fetchInfo(port) {
  const url = `${HOST}:${port}/`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TITLE_TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const hdr = `${res.headers.get("x-powered-by") || ""} ${res.headers.get("server") || ""}`;
    let framework = HEADER_MARKERS.find(([re]) => re.test(hdr))?.[1] || "";
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      return { title: `(${ct.split(";")[0] || "non-HTML"})`, framework, server: hdr.trim() };
    }
    const html = (await res.text()).slice(0, 200000);
    framework = FRAMEWORK_MARKERS.find(([re]) => re.test(html))?.[1] || framework;
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const metas = html.match(/<meta\b[^>]*>/gi) || [];
    const meta = (key) => {
      const tag = metas.find((t) => (attr(t, "name") || attr(t, "property") || "").toLowerCase() === key);
      return tag ? decode(attr(tag, "content") || "") : "";
    };
    const iconTag = (html.match(/<link\b[^>]*>/gi) || []).find((t) => /\bicon\b/i.test(attr(t, "rel") || ""));
    let favicon = `${url}favicon.ico`;
    try { if (iconTag && attr(iconTag, "href")) favicon = new URL(attr(iconTag, "href"), url).href; } catch {}
    return {
      title: m ? decode(m[1]).slice(0, 120) || "(empty <title>)" : "(no <title>)",
      description: (meta("description") || meta("og:description")).slice(0, 220),
      framework,
      favicon,
      server: hdr.trim(),
    };
  } catch {
    return { title: "(title unavailable)" };
  } finally {
    clearTimeout(t);
  }
}

// Inline SVG icons (stroke = currentColor, so they follow the theme).
const svg = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  kill: svg('<path d="M12 3v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>'),
  go: svg('<path d="M7 17L17 7"/><path d="M9 7h8v8"/>'),
};

function card(port, title) {
  const url = `${HOST}:${port}/`;
  const el = document.createElement("article");
  el.className = "card";
  el.innerHTML = `
    <div class="card-head">
      <a class="open" href="${url}" title="Open ${url} in this tab">
        <span class="dot" aria-hidden="true"></span>
        <span class="ident">
          <span class="port"><span class="host">localhost</span>:${port}</span>
          <span class="title pending" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
        </span>
        <span class="go">${ICONS.go}</span>
      </a>
      <div class="actions">
        <button class="icon-btn copy" title="Copy ${url}" aria-label="Copy URL">${ICONS.copy}</button>
        <button class="icon-btn kill" title="Kill the process on port ${port}" aria-label="Kill process on port ${port}">${ICONS.kill}</button>
      </div>
    </div>
    ${showPreviews ? `<div class="preview">
      <iframe src="${url}" loading="lazy" referrerpolicy="no-referrer" tabindex="-1"
              title="Preview of ${url}"
              sandbox="allow-same-origin allow-scripts allow-forms"></iframe>
      <div class="overlay" hidden>
        <div>This app can't be previewed here</div>
        <small>It blocks embedding (X-Frame-Options / CSP) — open it from the header above.</small>
      </div>
    </div>` : ""}
    <div class="info">
      <div class="info-top">
        <img class="fav" alt="" hidden />
        <span class="chip framework" hidden></span>
        <span class="proc" hidden></span>
      </div>
      <div class="desc" hidden></div>
      <div class="where" hidden></div>
      <code class="cmd" hidden></code>
    </div>`;
  if (showPreviews) {
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
  }

  // Click anywhere on the card header to open the app in the current tab.
  // The link itself handles its own clicks (so Cmd/Ctrl/middle-click open a new tab).
  const head = el.querySelector(".card-head");
  head.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    window.location.href = url;
  });

  // Copy the port's URL to the clipboard, with a brief ✓ confirmation.
  const copyBtn = el.querySelector(".copy");
  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.innerHTML = ICONS.check;
      copyBtn.classList.add("copied");
      setTimeout(() => { copyBtn.innerHTML = ICONS.copy; copyBtn.classList.remove("copied"); }, 1200);
    } catch {
      toast(`Couldn't copy ${url}`, true);
    }
  });

  // Kill the process holding this port (via the native messaging host).
  el.querySelector(".kill").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!confirm(`Kill the process on port ${port}?`)) return;
    el.classList.add("killing");
    chrome.runtime.sendMessage({ type: "kill", port }, (res) => {
      if (chrome.runtime.lastError || !res?.ok) {
        el.classList.remove("killing");
        const err = chrome.runtime.lastError?.message || res?.error || "failed";
        toast(`Couldn't kill :${port} — ${err}`, true);
        return;
      }
      // Port is dead — drop the card.
      el.remove();
      updateCount();
      if (!gridEl.children.length) showEmpty();
      toast(`Killed :${port} (pid ${res.killed.join(", ")})`);
    });
  });

  return el;
}

// Fill a card from fetchInfo(): title in the header, the rest in the info block.
function setInfo(c, info) {
  c._info = info;
  saveCache();
  const titleEl = c.querySelector(".title");
  titleEl.textContent = info.title;
  titleEl.title = info.title;
  titleEl.classList.toggle("pending", info.title.startsWith("("));
  const show = (sel, text, tip) => {
    const el = c.querySelector(sel);
    el.hidden = !text;
    el.textContent = text || "";
    el.title = tip || text || "";
  };
  show(".desc", info.description);
  if (info.framework || !c.dataset.procFramework) show(".framework", info.framework || "");
  const fav = c.querySelector(".fav");
  if (info.favicon && fav.dataset.src !== info.favicon) {
    fav.dataset.src = info.favicon;
    fav.onload = () => (fav.hidden = false);
    fav.onerror = () => (fav.hidden = true);
    fav.src = info.favicon;
  }
}

// "~/code/11-2026/cutquote"
const tilde = (p) => (p || "").replace(/^\/Users\/[^/]+/, "~");
// "node /…/node_modules/.bin/vite --host" -> "vite --host"
function shortCmd(cmd, cwd) {
  let s = (cmd || "").replace(/^\S*\/(node|bun|deno|python3?|ruby)(\s|$)/, "$1$2");
  s = s.replace(/^node\s+\S*node_modules\/\.bin\//, "").replace(/\S*node_modules\/\.bin\//g, "");
  if (cwd && cwd !== "/") s = s.split(cwd + "/").join("");
  return tilde(s);
}
const CMD_FRAMEWORKS = [
  [/\bvite\b/, "Vite"], [/\bnext\b/, "Next.js"], [/\bastro\b/, "Astro"], [/\bnuxt\b/, "Nuxt"],
  [/storybook/, "Storybook"], [/manage\.py/, "Django"], [/\bflask\b/, "Flask"], [/uvicorn/, "Uvicorn"],
  [/jupyter/, "Jupyter"], [/\brails\b/, "Rails"], [/\bhugo\b/, "Hugo"],
];

// Fill the process part (project folder, command) from the native host.
function setProc(c, p) {
  if (!p) return;
  c._proc = p;
  saveCache();
  c.dataset.pid = p.pid;
  const proc = c.querySelector(".proc");
  proc.hidden = false;
  proc.textContent = p.name;
  proc.title = `pid ${p.pid}`;
  const where = c.querySelector(".where");
  const dir = p.cwd && p.cwd !== "/" ? tilde(p.cwd) : "";
  where.hidden = !dir;
  where.textContent = dir;
  where.title = p.cwd || "";
  const cmd = c.querySelector(".cmd");
  const short = shortCmd(p.cmd, p.cwd);
  cmd.hidden = !short;
  cmd.textContent = short;
  cmd.title = p.cmd || "";
  const fw = CMD_FRAMEWORKS.find(([re]) => re.test(p.cmd || ""))?.[1];
  const chip = c.querySelector(".framework");
  if (fw && !chip.textContent) { chip.textContent = fw; chip.hidden = false; c.dataset.procFramework = fw; }
}

// Ask the native host who listens on these ports (one request per scan, only
// for cards that don't know yet or whose server restarted).
function loadProcs(cards) {
  if (!cards.length || !chrome.runtime?.sendMessage) return;
  chrome.runtime.sendMessage({ type: "ports", ports: cards.map((c) => +c.dataset.port) }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) return;
    for (const c of cards) setProc(c, res.ports[c.dataset.port]);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Brief message at the bottom of the page (kill / copy results).
let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle("error", isError);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), isError ? 7000 : 3500);
}

// "3 running" pill next to the heading.
function updateCount() {
  const n = gridEl.children.length;
  countEl.textContent = `${n} running`;
  countEl.classList.toggle("live", n > 0);
}

// Scan progress: thin bar under the toolbar + spinning Rescan icon.
function setProgress(done, total) {
  const active = done < total;
  progressEl.classList.toggle("active", active);
  progressEl.firstElementChild.style.width = `${total ? (done / total) * 100 : 0}%`;
  scanBtn.setAttribute("aria-busy", String(active));
}

// "Updated 20:41:03" (+ auto-refresh hint) once a scan has finished.
function showIdleStatus() {
  if (!lastScanAt) return;
  const time = lastScanAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  statusEl.textContent = `Updated ${time}` + (autoTimer ? " · every 10s" : "");
}

// Empty panel: either "scanning…" (nothing found yet) or "nothing running".
function showEmpty(scanningPorts) {
  emptyEl.hidden = false;
  if (scanningPorts) {
    emptyEl.dataset.state = "scanning";
    $("empty-title").textContent = "Scanning localhost…";
    $("empty-msg").textContent = `Checking ${scanningPorts} ports for running dev servers.`;
    return;
  }
  emptyEl.dataset.state = "empty";
  $("empty-title").textContent = "Nothing running on localhost";
  $("empty-msg").innerHTML = lastProbeError
    ? `Every probe failed with <code>${escapeHtml(lastProbeError)}</code>. ` +
      `If that's "Failed to fetch" for all ports, the browser is likely blocking localhost requests ` +
      `— reload the extension and open a fresh tab. Otherwise start a dev server and rescan.`
    : "Start a dev server, then hit Rescan (or press <kbd>R</kbd>). Turn on auto-refresh to pick it up automatically.";
}

// Save what's on screen (ports + title/info + process), debounced.
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ports = [...gridEl.children].map((c) => ({ port: +c.dataset.port, info: c._info, proc: c._proc }));
    chrome.storage?.local.set({ [CACHE_KEY]: { at: lastScanAt ? lastScanAt.getTime() : Date.now(), ports } });
  }, 300);
}

// Paint the last known servers straight away (no probing).
function restoreCache(cache) {
  if (!cache?.ports?.length) return false;
  for (const e of cache.ports) {
    const c = card(e.port, e.info?.title || "(loading title…)");
    c.dataset.port = e.port;
    c.style.animation = "none"; // no entrance animation for cached rows
    gridEl.appendChild(c);
    if (e.info) { setInfo(c, e.info); }
    if (e.proc) { setProc(c, e.proc); }
  }
  emptyEl.hidden = true;
  updateCount();
  lastScanAt = new Date(cache.at);
  showIdleStatus();
  return true;
}

// Scan the port list. Cards for ports that are still up are kept as-is (their
// iframes don't reload, so auto-refresh doesn't flicker); new ports get a card,
// ports that stopped responding are removed once the scan finishes.
// quiet: background check — no progress bar or "Scanning n/m"; the list just updates.
// Only the Rescan button / R key show a visible scan.
async function scan({ quiet = false } = {}) {
  if (scanning) { rescanQueued = true; return; }
  scanning = true;
  const ports = parsePorts(portsConfig || DEFAULT_PORTS);
  const found = new Set();
  let done = 0;
  lastProbeError = "";
  if (!gridEl.children.length) quiet = false; // nothing to show yet: say we're looking
  if (!quiet) {
    setProgress(0, ports.length);
    statusEl.textContent = `Scanning 0/${ports.length}`;
  }
  if (!gridEl.children.length) showEmpty(ports.length);

  // Probe through a pool of concurrent workers. Closed ports fail fast, so a wide
  // port list stays quick; cards are inserted in port order as they're found.
  const concurrency = 48;
  let next = 0;
  const worker = async () => {
    while (next < ports.length) {
      const port = ports[next++];
      if (await probe(port)) {
        found.add(port);
        let c = gridEl.querySelector(`.card[data-port="${port}"]`);
        if (!c) {
          c = card(port, "(loading title…)");
          c.dataset.port = port;
          const after = [...gridEl.children].find((el) => +el.dataset.port > port);
          gridEl.insertBefore(c, after || null);
          emptyEl.hidden = true;
          updateCount();
        }
        fetchInfo(port).then((info) => setInfo(c, info));
      }
      done++;
      if (!quiet) {
        setProgress(done, ports.length);
        statusEl.textContent = `Scanning ${done}/${ports.length}`;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Drop cards for ports that no longer respond.
  for (const c of [...gridEl.children]) {
    if (!found.has(+c.dataset.port)) c.remove();
  }
  // Project folder + command: new cards, plus a periodic refresh (servers restart).
  const procStale = Date.now() - lastProcAt > 60000;
  const needProc = [...gridEl.children].filter((c) => procStale || !c.dataset.pid);
  if (needProc.length) { lastProcAt = Date.now(); loadProcs(needProc); }
  updateCount();
  lastScanAt = new Date();
  showIdleStatus();
  if (found.size) emptyEl.hidden = true;
  else showEmpty();
  saveCache();

  scanning = false;
  if (rescanQueued) { rescanQueued = false; scan({ quiet: true }); }
}

scanBtn.addEventListener("click", () => scan());
$("empty-scan").addEventListener("click", () => scan());
$("auto").addEventListener("change", (e) => {
  clearInterval(autoTimer);
  // Background tabs skip their turn; they rescan when you come back to them.
  autoTimer = e.target.checked
    ? setInterval(() => document.visibilityState === "visible" && scan({ quiet: true }), 10000)
    : null;
  if (!scanning) showIdleStatus();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  // Coming back to the tab: quietly re-check if it's been a while (or always with auto-refresh).
  if (autoTimer || !lastScanAt || Date.now() - lastScanAt > CACHE_FRESH) scan({ quiet: true });
});

// Keyboard: R rescans (N / Esc for notes live in notes.js). Ignored while typing
// or when a modifier is held, so browser shortcuts like Cmd+R keep working.
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "r" || e.key === "R") { e.preventDefault(); scan(); }
});

// Pick up port-list edits made on the Settings page (in any open tab) and rescan.
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.previews) {
    showPreviews = !!changes.previews.newValue;
    gridEl.replaceChildren();
    gridEl.classList.toggle("list", !showPreviews);
    scan();
  }
  if (area === "local" && changes.ports) {
    portsConfig = changes.ports.newValue || DEFAULT_PORTS;
    scan({ quiet: true });
  }
});

// Load the saved port list and run an initial scan.
// Show the cached servers first, then re-check in the background.
chrome.storage?.local.get(["ports", "previews", CACHE_KEY], (items) => {
  portsConfig = items.ports || DEFAULT_PORTS;
  showPreviews = !!items.previews;
  gridEl.classList.toggle("list", !showPreviews); // no previews: compact list instead of cards
  const cache = items[CACHE_KEY];
  const restored = restoreCache(cache);
  if (!restored || Date.now() - cache.at > CACHE_FRESH) scan({ quiet: restored });
});
