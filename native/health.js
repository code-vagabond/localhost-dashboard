// Health stats for the dashboard: last nights' sleep, HRV and resting heart rate,
// read from the Google Health API (Fitbit / Pixel) through the health-agent CLI
// (github.com/code-vagabond/health-agent, cloned + built at ~/code/health-agent,
// logged in via ~/.health-agent). Returns one compact row per day.
//
// Run directly to test:  node native/health.js [days]
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CLI = process.env.HEALTH_AGENT_CLI || path.join(os.homedir(), "code/health-agent/dist/index.js");

// Run `health-agent get <type> -w` (reconciled Fitbit/Pixel stream) and return its data points.
function get(type, extra = []) {
  const out = execFileSync(process.execPath, [CLI, "get", type, "-w", ...extra], {
    timeout: 25000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.toString("utf8"));
}
const points = (type, extra) => get(type, extra).dataPoints || [];

// Active Zone Minutes since `from` (YYYY-MM-DD), summed per local day and zone.
// The API returns one record per active minute (cardio/peak minutes already count 2),
// so page through with a date filter.
function azmByDay(from) {
  const byDay = {};
  let token = null;
  for (let page = 0; page < 10; page++) {
    const extra = ["-n", "1000", "-f", `active_zone_minutes.interval.civil_start_time >= "${from}"`];
    if (token) extra.push("--page-token", token);
    const res = get("active-zone-minutes", extra);
    for (const p of res.dataPoints || []) {
      const a = p.activeZoneMinutes;
      const d = a?.interval?.civilStartTime?.date;
      if (!d) continue;
      const k = ymd(d);
      const z = (byDay[k] ||= { fatBurn: 0, cardio: 0, peak: 0 });
      const n = +a.activeZoneMinutes || 0;
      if (a.heartRateZone === "FAT_BURN") z.fatBurn += n;
      else if (a.heartRateZone === "CARDIO") z.cardio += n;
      else if (a.heartRateZone === "PEAK") z.peak += n;
    }
    token = res.nextPageToken;
    if (!token) break;
  }
  return byDay;
}

const localYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const ymd = (d) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
// A night belongs to the day you woke up, in the local time recorded with it.
function localDate(iso, offset) {
  const secs = parseInt(offset, 10) || 0;
  return new Date(Date.parse(iso) + secs * 1000).toISOString().slice(0, 10);
}

function healthSummary(days = 7) {
  if (!fs.existsSync(CLI)) {
    return { ok: false, error: `health-agent not found at ${CLI}`, setup: true };
  }
  const byDay = new Map();
  const day = (k) => byDay.get(k) || byDay.set(k, { date: k }).get(k);
  const errors = [];
  const tryGet = (type) => {
    try { return points(type); }
    catch (e) {
      const msg = String(e.stderr || e.message || e);
      errors.push({ type, error: msg.trim().split("\n").pop().slice(0, 300) });
      return [];
    }
  };

  for (const p of tryGet("sleep")) {
    const s = p.sleep;
    if (!s?.interval || s.metadata?.mainSleep === false) continue;
    const k = localDate(s.interval.endTime, s.interval.endUtcOffset);
    const stages = Object.fromEntries((s.summary?.stagesSummary || []).map((x) => [x.type, +x.minutes]));
    const d = day(k);
    // Keep the longest main sleep if there are several for one day.
    const asleep = +(s.summary?.minutesAsleep || 0);
    if (d.sleep && d.sleep.asleep >= asleep) continue;
    d.sleep = {
      start: s.interval.startTime, end: s.interval.endTime,
      asleep, inBed: +(s.summary?.minutesInSleepPeriod || 0),
      deep: stages.DEEP ?? null, light: stages.LIGHT ?? null, rem: stages.REM ?? null, awake: stages.AWAKE ?? null,
    };
  }
  for (const p of tryGet("daily-heart-rate-variability")) {
    const h = p.dailyHeartRateVariability;
    if (!h?.date) continue;
    day(ymd(h.date)).hrv = Math.round(h.averageHeartRateVariabilityMilliseconds * 10) / 10;
  }
  for (const p of tryGet("daily-resting-heart-rate")) {
    const r = p.dailyRestingHeartRate;
    if (!r?.date) continue;
    day(ymd(r.date)).rhr = +r.beatsPerMinute;
  }

  // Cardio: real minutes in the cardio + peak heart-rate zones per day (AZM counts those
  // double, so halve back). Days with no record get 0 once the fetch has succeeded.
  let azm = null;
  try {
    const from = new Date(); from.setDate(from.getDate() - days - 1);
    azm = azmByDay(localYmd(from));
  } catch (e) {
    errors.push({ type: "active-zone-minutes", error: String(e.stderr || e.message || e).trim().split("\n").pop().slice(0, 300) });
  }

  const rows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
  if (azm) for (const r of rows) {
    const z = azm[r.date];
    r.cardio = z ? Math.round((z.cardio + z.peak) / 2) : 0;
  }
  if (!rows.length && errors.length) {
    const auth = errors.some((e) => /auth|token|login|401|invalid_grant|expired/i.test(e.error));
    return {
      ok: false,
      error: auth ? "health-agent login expired — run: node ~/code/health-agent/dist/index.js auth:login" : errors[0].error,
      auth,
    };
  }
  return { ok: true, at: Date.now(), days: rows, errors };
}

module.exports = { healthSummary };

if (require.main === module) {
  console.log(JSON.stringify(healthSummary(Number(process.argv[2]) || 7), null, 2));
}
