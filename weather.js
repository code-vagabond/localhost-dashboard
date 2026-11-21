// "Outside": rain for the next hours, UV index, today's sun curve and air quality
// for the same place the trams panel uses (tramLocation -> tramPlace, else the last
// geolocation fix, else central Berlin).
//
// Sources (all key-less, official or official-derived):
//   Rain / temperature  DWD (MOSMIX forecast, SYNOP observations, RV radar nowcast)
//                       via Bright Sky                       api.brightsky.dev
//   UV index            DWD UV-Gefahrenindex (daily max)     opendata.dwd.de
//                       + hourly shape from Copernicus CAMS  air-quality-api.open-meteo.com
//   Air quality         Umweltbundesamt station measurements + its Luftqualitaetsindex
//                       (API v4)                             luftdaten.umweltbundesamt.de
//                       fallback: CAMS European AQI          air-quality-api.open-meteo.com
//   Sun                 computed locally (NOAA solar position algorithm), no network
//
// The last result is cached in chrome.storage.local so a new tab paints instantly.
(() => {
  const BRIGHTSKY = "https://api.brightsky.dev";
  const UBA = "https://luftdaten.umweltbundesamt.de/api/air-data/v4";
  const DWD_UVI = "https://opendata.dwd.de/climate_environment/health/alerts/uvi.json";
  const CAMS = "https://air-quality-api.open-meteo.com/v1/air-quality";
  const BERLIN = { latitude: 52.52, longitude: 13.405 };
  const REFRESH_EVERY = 10 * 60 * 1000;
  const HOURS = 12;                 // rain look-ahead
  const MOVED_KM = 1;               // refetch when the tram location moves this far

  const $ = (id) => document.getElementById(id);
  const sunEl = $("outside-sun"), listEl = $("outside-list"), nowEl = $("outside-now");
  const rainEl = $("outside-rain");
  const CHART_HOURS = 48;           // Rain view: next 2 days; 8 visible, scroll right for more

  // Sun / Rain switcher. The choice is a per-browser convenience, so localStorage is enough.
  let view = "sun";
  try { if (localStorage.getItem("outsideView") === "rain") view = "rain"; } catch {}
  const tabs = [...document.querySelectorAll(".out-view [data-view]")];
  function setView(v, save = true) {
    view = v;
    for (const b of tabs) b.setAttribute("aria-selected", String(b.dataset.view === v));
    sunEl.hidden = v !== "sun";
    rainEl.hidden = v !== "rain";
    if (save) try { localStorage.setItem("outsideView", v); } catch {}
    if (v === "sun") drawSun(); else drawRain();
  }
  for (const b of tabs) b.addEventListener("click", () => setView(b.dataset.view));
  // A plain mouse wheel scrolls the hours sideways too (trackpads already can).
  rainEl.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || rainEl.scrollWidth <= rainEl.clientWidth) return;
    const atStart = rainEl.scrollLeft <= 0, atEnd = rainEl.scrollLeft + rainEl.clientWidth >= rainEl.scrollWidth - 1;
    if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return; // let the page scroll
    e.preventDefault();
    rainEl.scrollBy({ left: e.deltaY, behavior: "auto" });
  }, { passive: false });

  // Next 8 hours: one column per hour, bar height = DWD chance of precipitation.
  function drawRain() {
    const now = Date.now();
    const hours = (data?.rain && now - data.rain.at < 6 * 3600e3 ? data.rain.hours : [])
      .filter((h) => h.t + 3600e3 > now && Number.isFinite(h.prob)).slice(0, CHART_HOURS);
    if (!hours.length) {
      rainEl.innerHTML = `<span class="none">${data ? "No hourly forecast right now" : "Loading forecast…"}</span>`;
      rainEl.setAttribute("aria-label", "No hourly precipitation forecast");
      return;
    }
    const hr = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric" }).replace(/:00/, "");
    const day = (t) => new Date(t).toLocaleDateString([], { weekday: "short" });
    // Midnight columns show the weekday, so a long scroll stays readable.
    const label = (t, i) => i === 0 ? "Now" : new Date(t).getHours() === 0 ? day(t) : hr(t);
    const keep = rainEl.scrollLeft;
    rainEl.innerHTML = hours.map((h, i) => {
      const p = Number.isFinite(h.prob) ? Math.round(h.prob) : null;
      const wet = (p ?? 0) >= 30 || h.mm > 0;
      const tip = `${day(h.t)} ${hr(h.t)}: ${p ?? "?"}% chance of ${h.kind === "rain" ? "rain" : h.kind}${h.mm > 0 ? `, ${h.mm.toFixed(1)} mm` : ""}${Number.isFinite(h.clouds) ? ` · ${Math.round(h.clouds)}% cloud` : ""}`;
      return `<div class="h${wet ? " wet" : ""}${i === 0 ? " now" : ""}${i && new Date(h.t).getHours() === 0 ? " day" : ""}" title="${esc(tip)}">
        <span class="track"><span class="pct">${p ?? "–"}${p != null ? "%" : ""}</span><span class="bar" style="height:${Math.max(3, p ?? 0)}%"></span></span>
        <span class="t">${label(h.t, i)}</span>
        ${Number.isFinite(h.clouds) ? `<span class="cc"><i style="--c:${Math.round(h.clouds)}"></i>${Math.round(h.clouds)}%</span>` : ""}</div>`;
    }).join("");
    rainEl.scrollLeft = keep; // minute repaints don't jump back to "Now"
    const peak = hours.reduce((a, h) => ((h.prob ?? -1) > (a.prob ?? -1) ? h : a), hours[0]);
    rainEl.setAttribute("aria-label", `Chance of precipitation, next ${hours.length} hours. Highest ${Math.round(peak.prob ?? 0)}% at ${hr(peak.t)}.`);
    rainEl.title = "Bars: chance of precipitation · circles: cloud cover (empty = clear, full = overcast) · DWD forecast via Bright Sky";
  }
  const statusEl = $("outside-status"), refreshBtn = $("outside-refresh");
  if (!sunEl || !listEl) return;

  let data = null;      // { at, pos, rain, uv, air } — what's cached
  let pos = BERLIN;
  let loading = false;

  // ---------- helpers ----------
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const hourLabel = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const sin = (d) => Math.sin(rad(d)), cos = (d) => Math.cos(rad(d));
  const km = (a, b) => {
    const dy = (a.latitude - b.latitude) * 111.2;
    const dx = (a.longitude - b.longitude) * 111.2 * cos((a.latitude + b.latitude) / 2);
    return Math.hypot(dx, dy);
  };
  const dayStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function getJSON(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
    return res.json();
  }

  // Same place the trams use; never asks for geolocation itself.
  async function position() {
    const { tramLocation, tramPlace, tramLastPos } =
      await chrome.storage.local.get(["tramLocation", "tramPlace", "tramLastPos"]);
    const q = (tramLocation || "").trim();
    const ok = (p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
    if (q && tramPlace?.query === q && ok(tramPlace)) return tramPlace;
    if (!q && ok(tramLastPos)) return tramLastPos;
    return ok(tramPlace) ? tramPlace : ok(tramLastPos) ? tramLastPos : BERLIN;
  }

  // ---------- sun (NOAA solar position) ----------
  // Elevation of the sun's centre in degrees, without refraction.
  function elevation(ms, lat, lon) {
    const T = (ms / 86400000 + 2440587.5 - 2451545) / 36525;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
      sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
    const omega = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * sin(omega);
    const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * cos(omega);
    const decl = deg(Math.asin(sin(eps) * sin(lambda)));
    const y = Math.tan(rad(eps / 2)) ** 2;
    const eot = 4 * deg(y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) -
      0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M)); // minutes
    const utcMin = (((ms / 60000) % 1440) + 1440) % 1440;
    const tst = (((utcMin + eot + 4 * lon) % 1440) + 1440) % 1440;
    const cosZ = sin(lat) * sin(decl) + cos(lat) * cos(decl) * cos(tst / 4 - 180);
    return 90 - deg(Math.acos(Math.max(-1, Math.min(1, cosZ))));
  }

  // Today's curve: samples of "elevation above the apparent horizon" (0 = sunrise/
  // sunset, i.e. centre at -0.833°), plus the exact rise/set instants.
  function sunDay(now, p) {
    const t0 = dayStart(now), t1 = dayStart(t0 + 36 * 3600e3); // handles 23/25 h days
    const alt = (t) => elevation(t, p.latitude, p.longitude) + 0.833;
    const STEP = 10 * 60e3;
    const pts = [];
    let rise = null, set = null;
    for (let t = t0; ; t += STEP) {
      const tt = Math.min(t, t1), a = alt(tt);
      const prev = pts[pts.length - 1];
      if (prev && (prev.a < 0) !== (a < 0)) {
        let lo = prev.t, hi = tt;                       // bisect the crossing
        for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; ((alt(mid) < 0) === (prev.a < 0)) ? (lo = mid) : (hi = mid); }
        const x = (lo + hi) / 2;
        pts.push({ t: x, a: 0, cross: true });
        if (prev.a < 0) rise ??= x; else set = x;
      }
      pts.push({ t: tt, a });
      if (tt >= t1) break;
    }
    return { t0, t1, pts, rise, set, now: alt(now) };
  }

  function drawSun() {
    const now = Date.now();
    const s = sunDay(now, pos);
    const W = Math.round(sunEl.clientWidth);
    if (!W) return s; // hidden (Rain view): still return the times, UV uses them
    const H = 50, PAD = 7;
    const max = Math.max(1e-6, ...s.pts.map((p) => p.a)), min = Math.min(-1e-6, ...s.pts.map((p) => p.a));
    const X = (t) => PAD + ((t - s.t0) / (s.t1 - s.t0)) * (W - 2 * PAD);
    // One smooth, odd compression (asinh) for the whole day: the slope is continuous
    // through sunrise/sunset, and deep night (-60° in winter) still fits without
    // squashing the day arc. The horizon sits wherever that day's range puts it.
    const g = (a) => Math.asinh(a / 14);
    const scale = (H - 2 * PAD) / (g(max) - g(min));
    const horizon = PAD + g(max) * scale;
    const Y = (a) => horizon - g(a) * scale;
    const f = (n) => n.toFixed(1);

    // split the samples into runs above / below the horizon (crossings belong to both)
    const runs = [];
    let cur = null;
    for (const p of s.pts) {
      const day = p.cross ? cur?.day : p.a >= 0;
      if (!cur || (!p.cross && cur.day !== day)) { cur = { day, pts: cur ? [cur.pts[cur.pts.length - 1]] : [] }; runs.push(cur); }
      cur.pts.push(p);
    }
    const line = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${f(X(p.t))} ${f(Y(p.a))}`).join("");
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
      <defs><linearGradient id="sun-glow" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--sun)" stop-opacity=".26"/><stop offset="1" stop-color="var(--sun)" stop-opacity="0"/>
      </linearGradient></defs>`;
    for (const r of runs.filter((r) => r.day && r.pts.length > 1)) {
      const a = r.pts[0], b = r.pts[r.pts.length - 1];
      svg += `<path d="${line(r.pts)}L${f(X(b.t))} ${horizon}L${f(X(a.t))} ${horizon}Z" fill="url(#sun-glow)"/>`;
    }
    svg += `<line class="sun-horizon" x1="0" y1="${horizon}" x2="${W}" y2="${horizon}"/>`;
    for (const r of runs) if (r.pts.length > 1) svg += `<path class="${r.day ? "sun-day" : "sun-night"}" d="${line(r.pts)}"/>`;
    for (const t of [s.rise, s.set]) if (t) svg += `<circle class="sun-tick" cx="${f(X(t))}" cy="${horizon}" r="2"/>`;
    const cx = f(X(now)), cy = f(Y(s.now));
    svg += s.now >= 0
      ? `<circle class="sun-halo" cx="${cx}" cy="${cy}" r="10"/><circle class="sun-dot" cx="${cx}" cy="${cy}" r="4.5"/>`
      : `<circle class="sun-dot below" cx="${cx}" cy="${cy}" r="4"/>`;
    svg += `</svg><div class="sun-times">
      <span class="rise"></span><span class="len"></span><span class="set"></span></div>`;
    sunEl.innerHTML = svg;

    // sunrise / sunset labels sit under their crossing, clamped to the strip's edges
    const place = (el, x) => {
      const w = el.offsetWidth;
      const left = Math.max(0, Math.min(W - w, x - w / 2));
      el.style.left = `${left}px`;
      return [left, left + w];
    };
    const riseEl = sunEl.querySelector(".rise"), setEl = sunEl.querySelector(".set"), lenEl = sunEl.querySelector(".len");
    let label = "No sunrise today";
    if (s.rise && s.set) {
      const mins = Math.round((s.set - s.rise) / 60e3);
      riseEl.textContent = `↑ ${clock(s.rise)}`;
      setEl.textContent = `↓ ${clock(s.set)}`;
      lenEl.textContent = `${Math.floor(mins / 60)} h ${mins % 60} min`;
      const a = place(riseEl, X(s.rise)), b = place(setEl, X(s.set));
      const c = place(lenEl, (a[1] + b[0]) / 2);
      if (a[1] > b[0] - 8) setEl.style.left = `${Math.min(W - setEl.offsetWidth, a[1] + 8)}px`;
      lenEl.hidden = c[0] < a[1] + 10 || c[1] > b[0] - 10;
      const next = now < s.rise ? `Sunrise in ${dur(s.rise - now)}` : now < s.set ? `Sunset in ${dur(s.set - now)}` : "Sun has set";
      label = `Sunrise ${clock(s.rise)}, sunset ${clock(s.set)}, ${Math.floor(mins / 60)} h ${mins % 60} min of daylight. ${next}.`;
    } else {
      lenEl.textContent = s.now >= 0 ? "Sun up all day" : "Sun below the horizon all day";
      place(lenEl, W / 2);
      label = lenEl.textContent;
    }
    sunEl.title = `${label}\nComputed locally (NOAA solar position algorithm)`;
    sunEl.setAttribute("aria-label", label);
    return s;
  }
  const dur = (ms) => { const m = Math.max(1, Math.round(ms / 60e3)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

  // ---------- rain + current conditions: DWD via Bright Sky ----------
  const CONDITIONS = {
    "clear-day": "Clear", "clear-night": "Clear", "partly-cloudy-day": "Partly cloudy",
    "partly-cloudy-night": "Partly cloudy", cloudy: "Cloudy", fog: "Fog", wind: "Windy", rain: "Rain",
    sleet: "Sleet", snow: "Snow", hail: "Hail", thunderstorm: "Thunderstorm",
  };

  async function loadRain(p) {
    const q = `lat=${p.latitude.toFixed(4)}&lon=${p.longitude.toFixed(4)}`;
    const now = Date.now();
    const from = new Date(Math.floor(now / 3600e3) * 3600e3).toISOString();
    const to = new Date(now + (Math.max(HOURS, CHART_HOURS) + 2) * 3600e3).toISOString();
    const [hourly, current, radar] = await Promise.allSettled([
      getJSON(`${BRIGHTSKY}/weather?${q}&date=${from}&last_date=${to}`),
      getJSON(`${BRIGHTSKY}/current_weather?${q}`),
      getJSON(`${BRIGHTSKY}/radar?${q}&distance=0&format=plain&date=${new Date(now - 10 * 60e3).toISOString()}&last_date=${new Date(now + 2 * 3600e3).toISOString()}`),
    ]);
    if (hourly.status !== "fulfilled") throw hourly.reason;
    // Bright Sky stamps each record with the END of its hour.
    const hours = hourly.value.weather.map((w) => ({
      t: Date.parse(w.timestamp) - 3600e3,
      mm: w.precipitation ?? 0,
      prob: w.precipitation_probability,
      clouds: w.cloud_cover,
      kind: /snow|sleet|hail/.test(w.condition || "") ? w.condition : "rain",
    }));
    const out = { at: now, hours };
    if (current.status === "fulfilled" && current.value.weather) {
      const w = current.value.weather;
      out.current = {
        at: Date.parse(w.timestamp), temp: w.temperature, icon: w.icon, mm10: w.precipitation_10, clouds: w.cloud_cover,
        station: current.value.sources?.[0]?.station_name,
      };
    }
    if (radar.status === "fulfilled" && radar.value.radar?.length) {
      // precipitation_5: 0.01 mm per 5 min, here a 1x1 grid at our position
      out.radar = radar.value.radar.map((r) => ({ t: Date.parse(r.timestamp), mm: [r.precipitation_5].flat(3)[0] / 100 }));
    }
    return out;
  }

  // -> { value, detail, wet, hours[] (next HOURS, for the bars), title }
  function rainSummary(rain, now) {
    const hours = rain.hours.filter((h) => h.t + 3600e3 > now).slice(0, HOURS);
    const total = hours.reduce((s, h) => s + h.mm, 0);
    const noun = (h) => (h?.kind === "snow" ? "Snow" : h?.kind === "sleet" ? "Sleet" : "Rain");
    const title = `Next ${hours.length} h: ${total.toFixed(1)} mm` +
      `\nDWD forecast (MOSMIX) and radar nowcast, via Bright Sky`;
    const out = { hours, title, wet: false };

    // Radar nowcast (5-min steps, ~2 h): when does it start / stop?
    const WET = 0.03; // mm per 5 min ≈ 0.4 mm/h; below that is drizzle noise
    const frames = (rain.radar || []).filter((f) => f.t > now - 5 * 60e3 && rain.at > now - 20 * 60e3);
    if (frames.length >= 6) {
      const wet = frames.map((f) => f.mm >= WET);
      const rainingNow = wet[0] || wet[1];
      if (rainingNow) {
        const stop = wet.findIndex((w, i) => i > 0 && !w && !wet[i + 1] && !wet[i + 2]);
        const peak = Math.max(...frames.slice(0, 6).map((f) => f.mm)) * 12;
        out.wet = true;
        out.value = peak >= 4 ? `Heavy ${noun(hours[0]).toLowerCase()}` : noun(hours[0]);
        out.detail = stop > 0 ? `easing in ~${dur(frames[stop].t - now)}` : `for the next ${dur(frames[frames.length - 1].t - now)}+`;
        return out;
      }
      const start = wet.findIndex((w, i) => w && (wet[i + 1] || i === wet.length - 1));
      if (start > 0) {
        const mins = Math.max(5, Math.round((frames[start].t - now) / 300e3) * 5);
        out.wet = true;
        const rate = Math.max(...frames.slice(start).map((f) => f.mm)) * 12; // mm/h
        out.value = `${noun(hours[0])} in ~${mins} min`;
        out.detail = rate >= 10 ? "heavy" : rate >= 2.5 ? "moderate" : "light";
        out.more = " · DWD radar";
        return out;
      }
    }
    // Hourly forecast: first hour that is probably wet, else the highest chance.
    const likely = hours.find((h) => (h.prob ?? 0) >= 50 || (h.mm >= 0.2 && (h.prob ?? 100) >= 40));
    out.value = "Dry";
    if (likely && likely.t <= now) {
      out.wet = true;
      out.value = `${noun(likely)} likely`;
      out.detail = `this hour${likely.prob != null ? ` · ${likely.prob}%` : ""}`;
    } else if (likely) {
      out.detail = `${noun(likely).toLowerCase()} likely from ${hourLabel(likely.t)}`;
    } else {
      const top = hours.reduce((a, h) => ((h.prob ?? 0) > (a?.prob ?? 0) ? h : a), null);
      out.detail = top && top.prob >= 20 ? `${top.prob}% chance around ${hourLabel(top.t)}` : `for the next ${hours.length} h`;
    }
    return out;
  }

  // ---------- UV: DWD daily maximum + CAMS hourly ----------
  // Cities of DWD's UV-Gefahrenindex (the file has names only).
  const DWD_CITIES = {
    "Berlin": [52.52, 13.4], "Hamburg": [53.55, 9.99], "München": [48.14, 11.58], "Bonn": [50.73, 7.1],
    "Düsseldorf": [51.23, 6.78], "Frankfurt/Main": [50.11, 8.68], "Stuttgart": [48.78, 9.18],
    "Leipzig": [51.34, 12.37], "Dresden": [51.05, 13.74], "Hannover": [52.37, 9.73], "Bremen": [53.08, 8.8],
    "Nürnberg": [49.45, 11.08], "Kiel": [54.32, 10.13], "Rostock": [54.09, 12.14], "Magdeburg": [52.13, 11.63],
    "Cottbus": [51.76, 14.33], "Kassel": [51.31, 9.48], "Freiburg": [47.99, 7.84], "Ulm": [48.4, 9.99],
    "Konstanz": [47.66, 9.17], "Würzburg": [49.79, 9.95], "Regensburg": [49.01, 12.1], "Weimar": [50.98, 11.33],
    "Osnabrück": [52.28, 8.05], "Neubrandenburg": [53.56, 13.26], "Waren": [53.52, 12.68],
    "Seehausen": [52.89, 11.75], "Wernigerode": [51.83, 10.78], "List auf Sylt": [55.01, 8.41],
    "Norderney": [53.71, 7.15], "Sankt Peter-Ording": [54.3, 8.65], "Arkona": [54.68, 13.43],
    "Marienleuchte": [54.5, 11.24], "Hahn": [49.95, 7.26],
  };
  // WHO Global Solar UV Index exposure categories and colours.
  const uvCat = (v) => (v >= 11 ? ["Extreme", "#9a6bd6"] : v >= 8 ? ["Very high", "#e0352b"] :
    v >= 6 ? ["High", "#f0802a"] : v >= 3 ? ["Moderate", "#e9c53a"] : ["Low", "#5cb85c"]);

  async function loadUV(p) {
    const [dwd, cams] = await Promise.allSettled([
      getJSON(DWD_UVI),
      getJSON(`${CAMS}?latitude=${p.latitude.toFixed(3)}&longitude=${p.longitude.toFixed(3)}` +
        `&hourly=uv_index&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone&timeformat=unixtime&forecast_days=2&timezone=auto`),
    ]);
    const out = { at: Date.now(), days: {} };
    if (cams.status === "fulfilled" && cams.value.hourly) {
      const h = cams.value.hourly;
      out.hourly = h.time.map((t, i) => ({ t: t * 1000, v: h.uv_index[i] })).filter((x) => x.v != null);
      for (const x of out.hourly) {
        const d = dayStart(x.t);
        out.days[d] = { max: Math.max(out.days[d]?.max ?? 0, x.v), src: "CAMS" };
      }
      const c = cams.value.current;
      if (c?.european_aqi != null) out.camsAir = { at: c.time * 1000, eaqi: c.european_aqi, pm25: c.pm2_5 };
    }
    if (dwd.status === "fulfilled" && dwd.value.content && dwd.value.forecast_day) {
      let best = null;
      for (const c of dwd.value.content) {
        const ll = DWD_CITIES[c.city];
        if (!ll) continue;
        const d = km(p, { latitude: ll[0], longitude: ll[1] });
        if (d < 100 && (!best || d < best.d)) best = { d, c };
      }
      if (best) {
        const base = new Date(`${dwd.value.forecast_day}T00:00:00`).getTime();
        ["today", "tomorrow", "dayafter_to"].forEach((k, i) => {
          const v = best.c.forecast?.[k];
          if (Number.isFinite(v)) out.days[dayStart(base + i * 86400e3 + 12 * 3600e3)] = { max: v, src: "DWD", city: best.c.city };
        });
      }
    }
    if (!Object.keys(out.days).length) throw (dwd.reason || cams.reason || new Error("No UV data"));
    return out;
  }

  // ---------- sky: DWD cloud cover (%, observed now + hourly forecast) ----------
  const skyLabel = (c) => c <= 12 ? "Clear" : c <= 37 ? "Mostly clear" : c <= 62 ? "Partly cloudy" : c <= 87 ? "Mostly cloudy" : "Overcast";
  function skySummary(rain, now) {
    const hours = (rain?.hours || []).filter((h) => h.t + 3600e3 > now && Number.isFinite(h.clouds)).slice(0, 12);
    const cur = Number.isFinite(rain?.current?.clouds) && now - rain.current.at < 3 * 3600e3
      ? rain.current.clouds : hours[0]?.clouds;
    if (!Number.isFinite(cur)) return null;
    const c = Math.round(cur);
    // What changes over the next 12 hours: the clearest (or cloudiest) hour, if notably different.
    const hr = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric" }).replace(/:00/, "");
    const clear = hours.reduce((a, h) => (h.clouds < a.clouds ? h : a), hours[0] || { clouds: c });
    const cloudy = hours.reduce((a, h) => (h.clouds > a.clouds ? h : a), hours[0] || { clouds: c });
    let detail = "about the same next 12 h";
    if (hours.length && clear.clouds <= c - 25) detail = `clearer ~${hr(clear.t)} · ${Math.round(clear.clouds)}%`;
    else if (hours.length && cloudy.clouds >= c + 25) detail = `clouding over ~${hr(cloudy.t)} · ${Math.round(cloudy.clouds)}%`;
    return {
      value: `${skyLabel(c)} · ${c}%`,
      color: c <= 37 ? "var(--sun)" : c <= 62 ? "#a8a08a" : "#6e7681", // sunny → grey
      detail,
      title: `Cloud cover ${c}% (0% = clear sky, 100% = overcast).\nDWD observation/forecast via Bright Sky`,
    };
  }

  function uvSummary(uv, now, sun) {
    const today = dayStart(now), tomorrow = dayStart(today + 36 * 3600e3);
    const afterSunset = sun?.set && now > sun.set;
    const key = afterSunset && uv.days[tomorrow] ? tomorrow : today;
    const day = uv.days[key];
    if (!day) return null;
    const max = Math.round(day.max);
    const [label, color] = uvCat(max);
    let detail = key === tomorrow ? "tomorrow’s max" : "today’s max";
    const hrs = (uv.hourly || []).filter((x) => dayStart(x.t) === key);
    const peak = hrs.reduce((a, x) => (x.v > (a?.v ?? 0) ? x : a), null);
    if (key === today && sun?.now >= 0 && hrs.length) {
      const cur = hrs.reduce((a, x) => (Math.abs(x.t - now) < Math.abs(a.t - now) ? x : a));
      detail = `today’s max · now ${Math.round(cur.v)}`;
    } else if (peak && max >= 3) detail += ` · peak ${hourLabel(peak.t)}`;
    const src = day.src === "DWD" ? `DWD UV-Gefahrenindex for ${day.city}` : "Copernicus CAMS forecast (via Open-Meteo)";
    return { value: `${max} ${label}`, color, detail, title: `UV index, daily maximum: ${src}\nWHO exposure categories` };
  }

  // ---------- air quality: UBA stations (official), CAMS as fallback ----------
  // UBA Luftqualitaetsindex classes as returned by the API (0-4).
  const LQI = [["Very good", "#35b8c9"], ["Good", "#3fbf7f"], ["Moderate", "#e3b62f"], ["Poor", "#e8663d"], ["Very poor", "#b1325f"]];
  // European Air Quality Index bands (CAMS fallback only).
  const EAQI = [[20, "Good", "#35b8c9"], [40, "Fair", "#3fbf7f"], [60, "Moderate", "#e3b62f"], [80, "Poor", "#e8663d"],
    [100, "Very poor", "#b1325f"], [Infinity, "Extremely poor", "#7d2181"]];
  const COMPONENTS = { 1: "PM10", 3: "O₃", 4: "SO₂", 5: "NO₂", 9: "PM2.5" };

  // UBA wants local German date + hour (1-24, the hour that ends then).
  function ubaStamp(ms) {
    const s = new Date(ms).toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }); // "2026-11-21 22:45:10"
    return { date: s.slice(0, 10), hour: Number(s.slice(11, 13)) + 1 };
  }

  async function nearestStations(p) {
    const key = `${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}`;
    const { weatherStations: c } = await chrome.storage.local.get("weatherStations");
    if (c?.key === key && Date.now() - c.at < 7 * 86400e3) return c.stations;
    const a = ubaStamp(Date.now() - 24 * 3600e3), b = ubaStamp(Date.now());
    const res = await getJSON(`${UBA}/stations/json?use=airquality&lang=en&date_from=${a.date}&time_from=${a.hour}&date_to=${b.date}&time_to=${b.hour}`);
    const stations = Object.values(res.data || {})
      .map((s) => ({ id: s[0], name: s[2], type: s[16], km: km(p, { latitude: Number(s[8]), longitude: Number(s[7]) }) }))
      .filter((s) => s.km <= 40).sort((x, y) => x.km - y.km).slice(0, 3);
    chrome.storage.local.set({ weatherStations: { key, at: Date.now(), stations } });
    return stations;
  }

  async function loadAirUBA(p) {
    const stations = await nearestStations(p);
    const a = ubaStamp(Date.now() - 6 * 3600e3), b = ubaStamp(Date.now());
    for (const st of stations) {
      const res = await getJSON(`${UBA}/airquality/json?date_from=${a.date}&time_from=${a.hour}&date_to=${b.date}&time_to=${b.hour}&station=${st.id}&lang=en`);
      const rows = Object.values(res.data?.[st.id] || {})
        .map((r) => ({ end: new Date(r[0].replace(" ", "T")).getTime(), index: r[1], comps: r.slice(3).filter(Array.isArray) }))
        .filter((r) => r.index >= 0 && r.index < LQI.length && r.comps.length)
        .sort((x, y) => y.end - x.end);
      if (!rows.length) continue;
      // the newest hour often arrives without particulates; prefer a complete one
      const row = rows.slice(0, 3).find((r) => r.comps.some((c) => c[0] === 9)) || rows[0];
      const worst = row.comps.reduce((m, c) => (parseFloat(c[3]) > parseFloat(m[3]) ? c : m));
      return {
        at: Date.now(), scale: "lqi", level: row.index, measured: row.end,
        station: st.name, km: st.km, type: st.type,
        worst: { name: COMPONENTS[worst[0]] || "", value: worst[1] },
        comps: row.comps.map((c) => `${COMPONENTS[c[0]] || c[0]} ${c[1]}`).join(" · "),
      };
    }
    throw new Error("No UBA station nearby");
  }

  function airSummary(air, now) {
    if (!air || now - (air.measured || air.at) > 8 * 3600e3) return null;
    if (air.scale === "lqi") {
      const [label, color] = LQI[air.level];
      return {
        value: label, color,
        detail: `${air.worst.name} ${air.worst.value} µg/m³`, more: ` · ${air.station.replace(/^Berlin\s+/, "")}`,
        title: `Luftqualitätsindex ${air.level + 1}/5 (${label}), measured until ${clock(air.measured)}` +
          `\n${air.comps} µg/m³\nUmweltbundesamt station ${air.station} (${air.type}, ${air.km.toFixed(1)} km)`,
      };
    }
    const band = EAQI.find((b) => air.eaqi <= b[0]);
    return {
      value: band[1], color: band[2], detail: `EAQI ${Math.round(air.eaqi)}`, more: " · CAMS model",
      title: "European Air Quality Index, Copernicus CAMS model (via Open-Meteo)\nNo Umweltbundesamt station data available right now",
    };
  }

  // ---------- render ----------
  function row(key, s, extra = "") {
    const dot = s?.color ? `<i class="dot" style="background:${s.color}"></i>` : "";
    return `<li class="out-row"${s?.title ? ` title="${esc(s.title)}"` : ""}>
      <span class="k">${key}</span>
      <span class="v${s ? "" : " none"}">${dot}${esc(s?.value ?? "—")}</span>
      <span class="d">${esc(s?.detail ?? (data ? "unavailable" : ""))}${s?.more ? `<span class="more">${esc(s.more)}</span>` : ""}</span>${extra}</li>`;
  }

  function bars(hours) {
    if (!hours?.length) return "";
    return `<span class="rain-bars" aria-hidden="true">${hours.map((h) => {
      const hgt = h.mm > 0 ? Math.max(3, Math.min(16, Math.sqrt(h.mm / 4) * 16)) : 2;
      const o = h.mm > 0 ? 0.45 + 0.55 * Math.min(1, (h.prob ?? 60) / 80) : 1;
      return `<i class="${h.mm > 0 ? "wet" : ""}" style="height:${hgt.toFixed(1)}px;opacity:${o.toFixed(2)}"></i>`;
    }).join("")}</span>`;
  }

  function render() {
    const now = Date.now();
    const sun = drawSun();
    if (view === "rain") drawRain();
    const uv = data?.uv && now - data.uv.at < 36 * 3600e3 ? uvSummary(data.uv, now, sun) : null;
    const air = airSummary(data?.air, now);
    // Rain lives in the Rain chart now; the list keeps UV and air.
    const sky = skySummary(data?.rain && now - data.rain.at < 6 * 3600e3 ? data.rain : null, now);
    listEl.innerHTML = row("Sky", sky) + row("UV", uv) + row("Air", air);

    const c = data?.rain?.current;
    if (c && Number.isFinite(c.temp) && now - c.at < 3 * 3600e3) {
      nowEl.textContent = `${Math.round(c.temp)}°${CONDITIONS[c.icon] ? " " + CONDITIONS[c.icon] : ""}`;
      nowEl.title = `${c.temp.toFixed(1)} °C at ${clock(c.at)}${c.station ? `, DWD station ${c.station}` : ""} (via Bright Sky)`;
    } else nowEl.textContent = "";
  }

  // ---------- load / refresh ----------
  async function refresh() {
    if (loading) return;
    loading = true;
    refreshBtn.classList.add("spinning");
    try {
      pos = await position();
      const p = pos;
      const [rain, uv, air] = await Promise.allSettled([loadRain(p), loadUV(p), loadAirUBA(p)]);
      const same = data?.pos && km(data.pos, p) < MOVED_KM;
      const next = { at: Date.now(), pos: { latitude: p.latitude, longitude: p.longitude } };
      next.rain = rain.status === "fulfilled" ? rain.value : same ? data.rain : null;
      next.uv = uv.status === "fulfilled" ? uv.value : same ? data.uv : null;
      const cams = uv.status === "fulfilled" && uv.value.camsAir;
      next.air = air.status === "fulfilled" ? air.value
        : cams ? { at: Date.now(), scale: "eaqi", eaqi: cams.eaqi }
        : same ? data.air : null;
      const got = [rain, uv, air].filter((r) => r.status === "fulfilled").length;
      if (!got) throw rain.reason;
      data = next;
      chrome.storage.local.set({ weatherCache: data });
      statusEl.textContent = `Updated ${clock(data.at)}`;
    } catch (e) {
      statusEl.textContent = data ? "Offline · cached" : "Offline";
    } finally {
      loading = false;
      refreshBtn.classList.remove("spinning");
      render();
    }
  }

  // Cache written by an older version (no cloud cover yet) counts as stale too.
  const oldShape = () => data?.rain?.hours?.length && !data.rain.hours.some((h) => "clouds" in h);
  const stale = () => !data || Date.now() - data.at > REFRESH_EVERY || oldShape();
  refreshBtn.addEventListener("click", refresh);
  new ResizeObserver(() => view === "sun" && drawSun()).observe(sunEl);
  setView(view, false);
  // Sun position and "rain in N min" move on their own: repaint every minute,
  // refetch every 10 minutes while the tab is visible (and on focus if stale).
  setInterval(() => {
    render();
    if (document.visibilityState === "visible" && stale()) refresh();
  }, 60 * 1000);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && stale() && refresh());
  // Follow the trams panel when its location changes (new stop typed, or a first fix).
  chrome.storage.onChanged.addListener(async (c) => {
    if (!c.tramLocation && !c.tramPlace && !c.tramLastPos) return;
    const p = await position();
    if (km(p, pos) >= MOVED_KM) { pos = p; refresh(); }
  });

  chrome.storage.local.get("weatherCache", async ({ weatherCache }) => {
    pos = await position();
    if (weatherCache?.pos && km(weatherCache.pos, pos) < MOVED_KM) {
      data = weatherCache;
      statusEl.textContent = `Updated ${clock(data.at)}`;
    }
    render();
    if (stale()) refresh();
  });
})();
