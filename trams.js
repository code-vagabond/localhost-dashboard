// "Trams nearby": next tram departures from the closest BVG tram stops, via the
// public BVG REST API (v6.bvg.transport.rest). Location comes from the "Tram
// location" setting (a stop or address); if that's empty, from browser geolocation.
// The last result is cached so a new tab shows it instantly, then refreshes.
(() => {
  const API = "https://v6.bvg.transport.rest";
  const BVG_LINE_URL = "https://www.bvg.de/de/verbindungen/linienuebersicht/";
  const PAGE = 5;             // rows visible at once; scrolling to the end adds the next 5
  const MORE_MINUTES = 60;    // when the fetched list runs out, fetch this much further ahead
  const MAX_STOPS = 2;        // closest tram stops to merge
  const RADIUS = 800;         // metres
  const REFRESH_EVERY = 30 * 1000;
  const listEl = document.getElementById("trams-list");
  const emptyEl = document.getElementById("trams-empty");
  const statusEl = document.getElementById("trams-status");
  const refreshBtn = document.getElementById("trams-refresh");
  const editBtn = document.getElementById("trams-edit");
  let loading = false;
  let lastDeps = [];
  let shown = PAGE;           // how many rows are rendered (grows as you scroll)
  let lastStops = [];         // stops of the last load, reused to fetch later departures
  let loadingMore = false;
  let exhausted = false;      // BVG returned nothing new: stop asking

  const TRAM_ONLY = "suburban=false&subway=false&bus=false&ferry=false&express=false&regional=false&tram=true";

  async function get(path) {
    const res = await fetch(API + path, { cache: "no-store" });
    if (!res.ok) throw new Error(`BVG API ${res.status}`);
    return res.json();
  }

  const cleanName = (n) => (n || "").replace(/\s*\(Berlin\)$/, "");

  function geolocate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("No geolocation"));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
        (e) => reject(new Error(e.code === 1 ? "Location permission denied" : "Location unavailable")),
        { maximumAge: 10 * 60 * 1000, timeout: 10000 }
      );
    });
  }

  // Resolve the configured place (stop or address) to coordinates, cached by query.
  async function placeFromSetting(query) {
    const { tramPlace } = await chrome.storage.local.get("tramPlace");
    if (tramPlace?.query === query) return tramPlace;
    const hits = await get(`/locations?query=${encodeURIComponent(query)}&results=1&poi=false`);
    const loc = hits[0]?.location || hits[0];
    if (!loc?.latitude) throw new Error(`Couldn't find “${query}”`);
    const place = { query, latitude: loc.latitude, longitude: loc.longitude };
    chrome.storage.local.set({ tramPlace: place });
    return place;
  }

  async function position() {
    const { tramLocation } = await chrome.storage.local.get("tramLocation");
    const q = (tramLocation || "").trim();
    if (q) return placeFromSetting(q);
    try {
      const pos = await geolocate();
      chrome.storage.local.set({ tramLastPos: pos });
      return pos;
    } catch (e) {
      const { tramLastPos } = await chrome.storage.local.get("tramLastPos");
      if (tramLastPos) return tramLastPos;
      throw e;
    }
  }

  async function load() {
    const pos = await position();
    const stops = (await get(
      `/locations/nearby?latitude=${pos.latitude}&longitude=${pos.longitude}&results=12&distance=${RADIUS}&linesOfStops=false`
    )).filter((s) => s.products?.tram).slice(0, MAX_STOPS);
    if (!stops.length) return { deps: [], note: `No tram stops within ${RADIUS} m` };
    lastStops = stops;
    return { deps: await departuresFrom(stops, null, 45) };
  }

  // Departures from these stops, starting now (when = null) or at a given time.
  async function departuresFrom(stops, when, duration) {
    const seen = new Set();
    const deps = [];
    const at = when ? `&when=${encodeURIComponent(new Date(when).toISOString())}` : "";
    for (const stop of stops) {
      const { departures = [] } = await get(`/stops/${stop.id}/departures?duration=${duration}&results=20${at}&${TRAM_ONLY}`);
      for (const d of departures) {
        if (d.cancelled || seen.has(d.tripId)) continue;
        seen.add(d.tripId);
        deps.push({
          tripId: d.tripId,
          line: d.line?.name || "?",
          direction: cleanName(d.direction),
          stop: cleanName(stop.name),
          distance: stop.distance,
          when: Date.parse(d.when || d.plannedWhen),
          delay: d.delay ? Math.round(d.delay / 60) : 0,
        });
      }
    }
    deps.sort((a, b) => a.when - b.when);
    return deps;
  }

  // Scrolled to the end: show the next PAGE rows, fetching later departures if needed.
  async function showMore() {
    if (loadingMore) return;
    const upcoming = lastDeps.filter((d) => d.when > Date.now() - 60000);
    if (shown < upcoming.length) { shown += PAGE; return render(lastDeps, { keepScroll: true }); }
    if (exhausted || !lastStops.length || !upcoming.length) return;
    loadingMore = true;
    try {
      const after = upcoming[upcoming.length - 1].when + 1000;
      const known = new Set(lastDeps.map((d) => d.tripId + d.when));
      const more = (await departuresFrom(lastStops, after, MORE_MINUTES)).filter((d) => !known.has(d.tripId + d.when));
      if (!more.length) { exhausted = true; return; }
      shown += PAGE;
      render([...lastDeps, ...more], { keepScroll: true });
    } catch { /* offline: just stop here, the next scroll retries */ }
    finally { loadingMore = false; }
  }

  function mins(ms) {
    const m = Math.round((ms - Date.now()) / 60000);
    return m <= 0 ? "now" : `${m} min`;
  }

  // Wide windows: the list fills the right column's leftover height (CSS flex-basis 0),
  // so render as many rows as fit (+1 under the fade) and fetch later ones if needed.
  // Otherwise it's a fixed 5-row window. Either way it scrolls for more.
  function sizeWindow() {
    const row = listEl.querySelector("li");
    if (!row) return;
    const h = row.getBoundingClientRect().height;
    if (!h) return;
    if (getComputedStyle(listEl).flexBasis === "0px") {
      listEl.style.maxHeight = "";
      const fit = Math.ceil(listEl.clientHeight / h) + 1;
      if (shown < fit) { shown = fit; queueMicrotask(() => render(lastDeps, { keepScroll: true })); }
      else if (listEl.children.length < fit && !exhausted) showMore();
    } else {
      listEl.style.maxHeight = `${Math.round(h * PAGE + 4)}px`;
    }
  }
  new ResizeObserver(() => sizeWindow()).observe(listEl);
  // Fade the bottom edge only while there's more below.
  const markEnd = () => listEl.classList.toggle("at-end",
    listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 2 && exhausted);
  listEl.addEventListener("scroll", () => {
    if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 24) showMore();
    markEnd();
  }, { passive: true });

  function render(deps, { keepScroll = false } = {}) {
    lastDeps = deps;
    const top = listEl.scrollTop;
    listEl.replaceChildren(...deps.filter((d) => d.when > Date.now() - 60000).slice(0, shown).map((d) => {
      const li = document.createElement("li");
      li.className = "tram";
      li.innerHTML = `
        <span class="line"></span>
        <span class="what"><b></b></span>
        <span class="when"><span class="at"></span><span class="in"></span><span class="delay"></span></span>`;
      li.querySelector(".line").textContent = d.line;
      li.querySelector(".what b").textContent = d.direction;
      li.querySelector(".at").textContent = new Date(d.when).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      li.querySelector(".in").textContent = mins(d.when);
      const delay = li.querySelector(".delay");
      if (d.delay > 0) { delay.textContent = `+${d.delay}`; delay.classList.add("late"); }
      li.title = `${d.line} → ${d.direction} from ${d.stop} at ${new Date(d.when).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}\nOpen line ${d.line} on bvg.de`;
      // Click opens the line's page on bvg.de (route, timetable, disruptions).
      // Cmd/Ctrl/middle-click opens it in a new tab, like a normal link.
      const url = `${BVG_LINE_URL}${encodeURIComponent(d.line.toLowerCase())}`;
      li.setAttribute("role", "link");
      li.tabIndex = 0;
      const open = (newTab) => newTab ? window.open(url, "_blank", "noopener") : (location.href = url);
      li.addEventListener("click", (e) => open(e.metaKey || e.ctrlKey));
      li.addEventListener("auxclick", (e) => e.button === 1 && open(true));
      li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(e.metaKey || e.ctrlKey); });
      return li;
    }));
    sizeWindow();
    if (keepScroll) listEl.scrollTop = top;
    markEnd();
  }

  let editing = false; // edit form open: don't let refreshes replace it

  function showEmpty(msg) {
    if (editing) return;
    emptyEl.textContent = msg || "";
    emptyEl.hidden = !msg;
  }

  // Inline stop/address form. Used when geolocation fails, and by the edit button.
  // mode "ask": location failed; "edit": user clicked edit (empty = use my location).
  function askForStop(reason, { mode = "ask", value = "" } = {}) {
    editing = mode === "edit";
    emptyEl.hidden = false;
    emptyEl.innerHTML = `
      <div class="tram-ask-msg"></div>
      <form class="tram-ask">
        <input type="text" spellcheck="false" placeholder="Your stop or address, e.g. Alexanderplatz" />
        <button type="submit" class="primary">${editing ? "Save" : "Show trams"}</button>
        ${editing ? '<button type="button" class="tram-cancel">Cancel</button>' : ""}
      </form>`;
    emptyEl.querySelector(".tram-ask-msg").textContent = reason;
    const form = emptyEl.querySelector("form");
    const input = form.querySelector("input");
    input.value = value;
    const close = () => { editing = false; showEmpty(""); };
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const q = input.value.trim();
      if (!q && !editing) return;
      close();
      chrome.storage.local.set({ tramLocation: q }); // onChanged triggers refresh
    });
    form.querySelector(".tram-cancel")?.addEventListener("click", close);
    input.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && editing) close(); });
    if (editing || !listEl.children.length) { input.focus({ preventScroll: true }); input.select(); }
  }

  editBtn.addEventListener("click", async () => {
    if (editing) { editing = false; showEmpty(""); return; } // second click closes
    const { tramLocation } = await chrome.storage.local.get("tramLocation");
    askForStop("Show trams near (leave empty to use your location):", { mode: "edit", value: tramLocation || "" });
  });

  async function refresh() {
    if (loading) return;
    loading = true;
    refreshBtn.classList.add("spinning");
    try {
      const { deps, note } = await load();
      // Keep the later departures you already scrolled to, so a refresh doesn't cut the list short.
      const lastFresh = deps.length ? deps[deps.length - 1].when : 0;
      const later = lastFresh ? lastDeps.filter((d) => d.when > lastFresh) : [];
      exhausted = false;
      render([...deps, ...later], { keepScroll: true });
      showEmpty(note || (deps.length ? "" : "No trams in the next 45 minutes"));
      statusEl.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      chrome.storage.local.set({ tramCache: { deps, at: Date.now() } });
    } catch (e) {
      if (/location/i.test(e.message) && !emptyEl.querySelector("form")) askForStop(`${e.message}. Where should I look for trams?`);
      else if (/^Couldn't find/.test(e.message)) { chrome.storage.local.remove("tramLocation"); askForStop(`${e.message}. Where should I look for trams?`); }
      else if (!lastDeps.length) showEmpty(e.message);
      statusEl.textContent = lastDeps.length ? "Offline · cached" : "";
    } finally {
      loading = false;
      refreshBtn.classList.remove("spinning");
    }
  }

  refreshBtn.addEventListener("click", refresh);
  // Re-render countdowns every 15s; fetch fresh data every 30s while visible.
  setInterval(() => lastDeps.length && render(lastDeps, { keepScroll: true }), 15000);
  setInterval(() => document.visibilityState === "visible" && refresh(), REFRESH_EVERY);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());
  chrome.storage.onChanged.addListener((c) => { if (c.tramLocation) { lastDeps = []; shown = PAGE; exhausted = false; listEl.scrollTop = 0; refresh(); } });

  chrome.storage.local.get("tramCache", ({ tramCache }) => {
    if (tramCache?.deps?.length) render(tramCache.deps);
    refresh();
  });
})();
