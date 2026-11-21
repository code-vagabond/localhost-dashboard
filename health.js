// "Health": last night's sleep plus 7-day sleep / HRV / resting-HR trends, read from
// Fitbit / Google Health by the health-agent CLI through the native host
// (native/health.js, relayed by background.js as { type: "health" }).
//
// The CLI takes a few seconds and the numbers only change a few times a day, so the
// last result is cached in chrome.storage.local (healthCache): a new tab paints from
// the cache at once and refetches quietly when it is older than 30 minutes.
(() => {
  const DAYS = 7;
  const STALE_AFTER = 30 * 60 * 1000;
  const RETRY_AFTER = 5 * 60 * 1000;    // after a failed refresh
  const LOGIN_CMD = "node ~/code/health-agent/dist/index.js auth:login";
  const CHART_H = 28;

  const $ = (id) => document.getElementById(id);
  const bodyEl = $("health-body"), noteEl = $("health-note"), statusEl = $("health-status");
  const refreshBtn = $("health-refresh");
  if (!bodyEl) return;

  let data = null;       // { at, days: [...] } — last good answer
  let problem = null;    // { error, auth } from the last failed refresh
  let lastTry = 0, loading = false;

  // ---------- formatting ----------
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const hourLabel = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  // 318 -> "5 h 18 min", 65 -> "1 h 05", 12 -> "12 min"
  const dur = (min, long = false) => {
    const m = Math.round(min), h = Math.floor(m / 60), r = m % 60;
    if (!h) return `${r} min`;
    return long ? `${h} h ${r} min` : `${h} h ${String(r).padStart(2, "0")}`;
  };
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const dayDate = (s) => new Date(`${s}T12:00:00`);   // noon: safe from DST edges
  const dayName = (s) => dayDate(s).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // The window: 7 consecutive calendar days ending at the newest day that has data
  // (days without data stay in as gaps, so the three charts share one x axis).
  function windowDays(days) {
    const byDate = new Map(days.map((d) => [d.date, d]));
    const last = days.map((d) => d.date).sort().pop();
    const end = dayDate(last), out = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(end); d.setDate(end.getDate() - i);
      const k = ymd(d);
      out.push(byDate.get(k) || { date: k });
    }
    return out;
  }

  // ---------- charts ----------
  const METRICS = {
    sleep: {
      label: "Sleep", kind: "bars",
      get: (d) => (num(d.sleep?.asleep) && d.sleep.asleep > 0 ? d.sleep.asleep : null),
      text: (v) => dur(v), tip: (v) => `${dur(v, true)} asleep`,
    },
    hrv: {
      label: "HRV", kind: "line", minSpan: 30,
      get: (d) => (num(d.hrv) ? d.hrv : null),
      text: (v) => `${Math.round(v)} ms`, tip: (v) => `HRV ${Math.round(v)} ms`,
    },
    rhr: {
      label: "RHR", kind: "line", minSpan: 6,
      get: (d) => (num(d.rhr) ? d.rhr : null),
      text: (v) => `${Math.round(v)} bpm`, tip: (v) => `Resting HR ${Math.round(v)} bpm`,
    },
    cardio: {
      label: "Cardio", kind: "bars", minTop: 20, // a short session isn't a full bar
      get: (d) => (num(d.cardio) ? d.cardio : null),
      text: (v) => `${Math.round(v)} min`, tip: (v) => `${Math.round(v)} min in cardio/peak zones`,
    },
  };

  function chartSVG(key, win, W) {
    const m = METRICS[key], H = CHART_H;
    const vals = win.map(m.get), have = vals.filter(num);
    if (!have.length || W < 40) return "";
    const slot = W / win.length, cx = (i) => (i + 0.5) * slot;
    const mean = avg(have);
    const lastIdx = vals.reduce((k, v, i) => (num(v) ? i : k), -1);
    let y, marks = "";

    if (m.kind === "bars") {
      const top = Math.max(m.minTop || 0, ...have), bw = Math.max(4, Math.min(14, slot * 0.42));
      y = (v) => H - (v / top) * (H - 2);
      vals.forEach((v, i) => {
        if (!num(v)) return;
        // rounded top, square foot on the baseline
        // any non-zero day stays visible (3px) next to a long session
        const x = cx(i) - bw / 2, t = v > 0 ? Math.min(y(v), H - 3) : y(v), r = Math.min(2, (H - t) / 2);
        marks += `<path class="hl-bar${i === lastIdx ? " last" : ""}" d="M${x.toFixed(1)} ${H}V${(t + r).toFixed(1)}q0 ${-r} ${r} ${-r}h${(bw - 2 * r).toFixed(1)}q${r} 0 ${r} ${r}V${H}z"/>`;
      });
    } else {
      let lo = Math.min(...have), hi = Math.max(...have);
      const grow = (m.minSpan - (hi - lo)) / 2;
      if (grow > 0) { lo -= grow; hi += grow; }
      const pad = 5;
      y = (v) => pad + ((hi - v) / (hi - lo)) * (H - 2 * pad);
      // one path per unbroken run, so a missing day leaves a gap rather than a false slope
      let run = [];
      const flush = () => {
        if (run.length > 1) marks += `<path class="hl-line" d="M${run.map(([a, b]) => `${a.toFixed(1)} ${b.toFixed(1)}`).join("L")}"/>`;
        run = [];
      };
      vals.forEach((v, i) => (num(v) ? run.push([cx(i), y(v)]) : flush()));
      flush();
      vals.forEach((v, i) => {
        if (!num(v)) return;
        marks += i === lastIdx
          ? `<circle class="hl-halo" cx="${cx(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="6"/><circle class="hl-dot last" cx="${cx(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"/>`
          : `<circle class="hl-dot" cx="${cx(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2"/>`;
      });
    }

    const zones = win.map((d, i) =>
      `<rect class="hl-zone" data-i="${i}" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}" rx="3"/>`).join("");
    const ref = have.length > 1
      ? `<line class="hl-avg" x1="0" x2="${W}" y1="${y(mean).toFixed(1)}" y2="${y(mean).toFixed(1)}"/>` : "";
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${zones}${ref}<g class="hl-marks">${marks}</g></svg>`;
  }

  // Hovering a day in any chart shows that day's values in all rows and highlights
  // the same day across the charts + axis (the axis letter says which day).
  function setHover(i) {
    const win = data?.days?.length ? windowDays(data.days) : [];
    const d = i == null ? null : win[i];
    bodyEl.querySelector(".hl-trends")?.classList.toggle("hovering", !!d);
    for (const row of bodyEl.querySelectorAll(".hl-row[data-metric]")) {
      const m = METRICS[row.dataset.metric], vv = row.querySelector(".vv");
      if (!m || !vv) continue; // cardio rows have their own week, not part of the day hover
      const val = d ? m.get(d) : null;
      vv.querySelector(".v").textContent = d ? (num(val) ? m.text(val) : "—") : vv.dataset.v;
      // the highlighted day letter on the axis says which day; keep the line height with a blank
      vv.querySelector(".s").textContent = d ? "\u00a0" : vv.dataset.s;
    }
    for (const el of bodyEl.querySelectorAll(".hl-zone, .hl-days span")) {
      el.classList.toggle("on", d != null && +el.dataset.i === i);
    }
  }
  bodyEl.addEventListener("mouseover", (e) => {
    const z = e.target.closest?.(".hl-zone, .hl-days span[data-i]");
    if (z) setHover(+z.dataset.i);
  });
  bodyEl.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget?.closest?.(".hl-zone, .hl-days span[data-i]")) setHover(null);
  });

  function drawCharts() {
    if (!data?.days?.length) return;
    const win = windowDays(data.days);
    for (const el of bodyEl.querySelectorAll(".hl-chart")) {
      el.innerHTML = chartSVG(el.dataset.metric, win, Math.floor(el.clientWidth));
    }
  }

  // ---------- render ----------
  function nightHTML(win) {
    const d = [...win].reverse().find((x) => METRICS.sleep.get(x));
    if (!d) return `<div class="hl-night"><div class="hl-hero"><span class="hl-total none">No sleep recorded</span></div></div>`;
    const s = d.sleep, today = ymd(new Date());
    const when = d.date === today ? "Last night" : `${dayDate(d.date).toLocaleDateString([], { weekday: "long" })} morning`;
    const h = Math.floor(s.asleep / 60), r = Math.round(s.asleep % 60);
    const total = `${h ? `<b>${h}</b> h ` : ""}<b>${r}</b> min`;
    const stages = [["deep", "Deep"], ["light", "Light"], ["rem", "REM"], ["awake", "Awake"]]
      .filter(([k]) => num(s[k]) && s[k] > 0);
    const sum = stages.reduce((a, [k]) => a + s[k], 0);
    const pct = (k) => Math.round((s[k] / sum) * 100);
    const span = s.start && s.end ? `${hourLabel(s.start)} – ${hourLabel(s.end)}` : "";
    const tip = `${dayName(d.date)} · asleep ${dur(s.asleep, true)}` +
      (s.inBed ? ` of ${dur(s.inBed, true)} in bed (${Math.round((s.asleep / s.inBed) * 100)}%)` : "") +
      (span ? `\nBed ${hourLabel(s.start)}, up ${hourLabel(s.end)}` : "") +
      (stages.length ? `\n${stages.map(([k, n]) => `${n} ${dur(s[k], true)} (${pct(k)}%)`).join(" · ")}` : "");
    return `<div class="hl-night" title="${esc(tip)}">
      <div class="hl-hero">
        <span class="hl-total">${total}</span>
        <span class="hl-when"><span class="lbl">${esc(when)}</span><span class="span">${esc(span)}</span></span>
      </div>
      ${stages.length ? `<div class="hl-stages" role="img" aria-label="Sleep stages: ${esc(stages.map(([k, n]) => `${n} ${dur(s[k], true)}`).join(", "))}">
        ${stages.map(([k]) => `<i class="${k}" style="flex:${s[k]}"></i>`).join("")}
      </div>
      <div class="hl-legend">${stages.map(([k, n]) => `<span><i class="${k}"></i>${n} <b>${dur(s[k])}</b></span>`).join("")}</div>` : ""}
    </div>`;
  }

  function trendHTML(key, win) {
    const m = METRICS[key];
    const vals = win.map(m.get).filter(num);
    if (!vals.length) {
      return `<li class="hl-row"><span class="k">${m.label}</span><span class="vv"><span class="v none">—</span></span><span class="hl-chart-empty">no data</span></li>`;
    }
    const mean = avg(vals), last = vals[vals.length - 1];
    const range = `${m.text(Math.min(...vals))} – ${m.text(Math.max(...vals))}`;
    // Sleep's latest night is the headline above, so its row leads with the average.
    // Latest day's value, with the 7-day average below; cardio shows the 7-day total.
    const total = vals.reduce((a, b) => a + b, 0);
    const v = key === "cardio" ? m.text(total) : m.text(last);
    const sub = key === "sleep" ? `avg ${m.text(mean)}` : key === "cardio" ? `${win.length} days` : `avg ${Math.round(mean)}`;
    const tip = `${m.label === "RHR" ? "Resting heart rate" : m.label === "HRV" ? "Heart rate variability (nightly average)" : m.label === "Cardio" ? "Minutes in the cardio + peak heart-rate zones" : "Time asleep"}, last ${win.length} days` +
      `\nLatest ${m.text(last)} · average ${m.text(mean)} · range ${range}`;
    return `<li class="hl-row" data-metric="${key}">
      <span class="k" title="${esc(tip)}">${m.label}</span>
      <span class="vv" title="${esc(tip)}" data-v="${esc(v)}" data-s="${esc(sub)}"><span class="v">${esc(v)}</span><span class="s">${esc(sub)}</span></span>
      <div class="hl-chart" data-metric="${key}"></div></li>`;
  }

  function axisHTML(win) {
    const today = ymd(new Date());
    return `<li class="hl-row hl-axis" aria-hidden="true"><span></span><span></span><div class="hl-days">${
      win.map((d, i) => `<span data-i="${i}" class="${d.date === today ? "today" : ""}">${dayDate(d.date).toLocaleDateString([], { weekday: "narrow" })}</span>`).join("")
    }</div></li>`;
  }

  function note() {
    const has = !!data?.days?.length;
    let html = "";
    if (problem?.auth) {
      html = `Google login expired${has ? " — showing the last numbers" : ""}. Run <code>${esc(LOGIN_CMD)}</code>`;
    } else if (problem && !has) {
      html = /native messaging host|not found|forbidden/i.test(problem.error) && !/health-agent/.test(problem.error)
        ? "Health numbers are read by the extension's helper. Install it with <code>native/install.sh &lt;extension id&gt;</code>, then reload the extension."
        : `Couldn't load health data: ${esc(problem.error)}`;
    } else if (!has && data) {
      html = `No sleep, HRV or heart-rate data for the last ${DAYS} days.`;
    } else if (!has && loading) {
      html = "Reading sleep, HRV and resting heart rate…";
    }
    noteEl.innerHTML = html;
    noteEl.hidden = !html;
  }

  function status() {
    statusEl.title = problem?.error || "";
    if (problem) statusEl.textContent = data?.days?.length ? (problem.auth ? "Login expired · cached" : "Couldn't refresh") : "";
    else if (data) {
      const sameDay = ymd(new Date(data.at)) === ymd(new Date());
      statusEl.textContent = `Updated ${sameDay ? clock(data.at) : new Date(data.at).toLocaleDateString([], { weekday: "short" }) + " " + clock(data.at)}`;
    } else statusEl.textContent = loading ? "Loading…" : "";
  }

  function render() {
    if (data?.days?.length) {
      const win = windowDays(data.days);
      bodyEl.innerHTML = `${nightHTML(win)}<ul class="hl-trends">${
        trendHTML("sleep", win)}${trendHTML("hrv", win)}${trendHTML("rhr", win)}${
        win.some((d) => "cardio" in d) ? trendHTML("cardio", win) : ""}${axisHTML(win)}</ul>`;
      bodyEl.hidden = false;
      drawCharts();
    } else {
      bodyEl.innerHTML = "";
      bodyEl.hidden = true;
    }
    note();
    status();
  }

  // ---------- load / refresh ----------
  function refresh() {
    if (loading) return;
    loading = true;
    lastTry = Date.now();
    refreshBtn.classList.add("spinning");
    if (!data) { note(); status(); }
    // Ask the native host directly (extension pages may), so this doesn't depend on
    // the background service worker having been reloaded with a "health" relay.
    const ask = (cb) => chrome.runtime.sendNativeMessage
      ? chrome.runtime.sendNativeMessage("com.linh.localhost_dashboard", { type: "health", days: DAYS }, cb)
      : chrome.runtime.sendMessage({ type: "health", days: DAYS }, cb);
    ask((res) => {
      loading = false;
      refreshBtn.classList.remove("spinning");
      const error = chrome.runtime.lastError?.message || (!res?.ok && (res?.error || "no response"));
      if (error) {
        problem = { error: String(error), auth: !!res?.auth };
      } else {
        problem = null;
        const days = (res.days || []).filter((d) => d?.date);
        // A partial answer (some streams failed) must not wipe good cached numbers.
        if (days.length || !res.errors?.length || !data) {
          data = { at: res.at || Date.now(), days };
          chrome.storage.local.set({ healthCache: data });
        } else {
          problem = { error: res.errors.map((e) => `${e.type}: ${e.error}`).join("\n"), auth: false };
        }
      }
      render();
    });
  }

  const stale = () => {
    const now = Date.now();
    if (problem || !data) return now - lastTry > RETRY_AFTER;
    // cache from before weekly cardio existed: fetch once now
    return now - data.at > STALE_AFTER || !data.days.some((d) => "cardio" in d);
  };
  refreshBtn.addEventListener("click", refresh);
  new ResizeObserver(drawCharts).observe(bodyEl);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && stale() && refresh());
  // a tab left open: check every few minutes (also rolls "Last night" over at midnight)
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (stale()) refresh(); else render();
  }, 5 * 60 * 1000);

  // Instant paint from cache, then refetch only if it's old.
  chrome.storage.local.get("healthCache", ({ healthCache }) => {
    if (Array.isArray(healthCache?.days)) data = healthCache;
    render();
    if (!data || stale()) refresh();
  });
})();
