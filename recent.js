// "Recent sessions" list: the 7 latest Claude Code / Claude Desktop / Codex /
// Cursor sessions, read from local history files by the native host (native/sessions.js).
// The last result is cached so a new tab shows it instantly, then refreshes.
(() => {
  const LIMIT = 7;
  const STALE_AFTER = 60 * 1000; // refresh on tab focus if older than this
  const TOOLS = {
    "claude-code": "Claude Code",
    "claude-desktop": "Claude Desktop",
    codex: "Codex",
    "cursor-cli": "Cursor CLI",
    "cursor-app": "Cursor",
  };
  // App each row brings to the front after copying.
  const APPS = {
    "claude-code": "Ghostty",
    codex: "Ghostty",
    "cursor-cli": "Ghostty",
    "claude-desktop": "Claude",
    "cursor-app": "Cursor",
  };
  const listEl = document.getElementById("sessions-list");
  const emptyEl = document.getElementById("sessions-empty");
  const statusEl = document.getElementById("sessions-status");
  const refreshBtn = document.getElementById("sessions-refresh");
  let fetchedAt = 0;
  let loading = false;

  // "now" / "12m" / "3h" / "Yesterday" / "Mon" / "12 Sep"
  function ago(ms) {
    const mins = Math.round((Date.now() - ms) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m ago`;
    const then = new Date(ms);
    const startOfToday = new Date().setHours(0, 0, 0, 0);
    if (ms >= startOfToday) return `${Math.round(mins / 60)}h ago`;
    if (ms >= startOfToday - 86400000) return "Yesterday";
    if (ms >= startOfToday - 6 * 86400000) return then.toLocaleDateString(undefined, { weekday: "short" });
    return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  // Last two path segments, with ~ for home: "~/code/my-app" / "work/my-app".
  function shortPath(cwd) {
    if (!cwd) return "";
    const home = cwd.match(/^\/Users\/[^/]+/)?.[0];
    const p = home ? "~" + cwd.slice(home.length) : cwd;
    const parts = p.split("/").filter(Boolean);
    return parts.length > 2 ? parts.slice(-2).join("/") : p;
  }

  function row(s) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "session";
    btn.innerHTML = `
      <span class="tool"></span>
      <span class="what"><b></b><span class="sub"><span class="where"></span><span class="query"></span></span></span>
      <span class="when"><span class="ago"></span><span class="hint"></span></span>`;
    const tool = btn.querySelector(".tool");
    tool.dataset.tool = s.tool;
    tool.textContent = TOOLS[s.tool] || s.tool;
    const title = s.title || s.query;
    btn.querySelector(".what b").textContent = title;
    // Second line: "folder · prompt". The home folder ("~") says nothing, so skip it.
    const where = shortPath(s.cwd);
    const whereEl = btn.querySelector(".where");
    whereEl.textContent = where === "~" ? "" : where;
    whereEl.title = s.cwd || "";
    btn.querySelector(".query").textContent = s.title && s.query ? s.query : "";
    if (whereEl.textContent && s.title && s.query) whereEl.textContent += " · ";
    if (!btn.querySelector(".sub").textContent) btn.querySelector(".sub").replaceChildren();
    btn.querySelector(".ago").textContent = ago(s.updatedAt);
    btn.querySelector(".hint").textContent = s.resume ? "Resume ↗" : "Open ↗";
    btn.title = (s.query ? `${s.query}\n\n` : "") +
      (s.resume ? `Click to copy and switch to Ghostty: ${s.resume}` : `Click to copy the prompt and open ${APPS[s.tool]}`);

    // Click copies the resume command and brings Ghostty to the front, ready to
    // paste. Claude Desktop / Cursor rows have no resume command: they copy the
    // prompt and bring their own app forward instead.
    btn.addEventListener("click", async () => {
      const text = s.resume || s.query || title;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return toast("Couldn't copy to the clipboard", true);
      }
      const app = APPS[s.tool];
      toast(s.resume ? `Resume command copied. Paste it in ${app}.` : `Prompt copied. Opening ${app}…`);
      chrome.runtime.sendMessage({ type: "focus", app, path: s.cwd }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          toast(`Copied, but couldn't switch to ${app}`, true);
        }
      });
    });
    li.appendChild(btn);
    return li;
  }

  function render(sessions) {
    listEl.replaceChildren(...sessions.map(row));
    emptyEl.hidden = sessions.length > 0;
    if (!sessions.length) emptyEl.textContent = "No sessions found yet.";
  }

  function showError(error) {
    // Keep showing cached rows if we have them; just flag the failed refresh.
    if (listEl.children.length) {
      statusEl.textContent = "Couldn't refresh";
      statusEl.title = error;
      return;
    }
    emptyEl.hidden = false;
    emptyEl.innerHTML = /native messaging host|not found|forbidden/i.test(error)
      ? "Sessions are read by the extension's helper. Install it with " +
        "<code>native/install.sh &lt;extension id&gt;</code>, then reload the extension."
      : "Couldn't load sessions: ";
    if (!/native messaging host|not found|forbidden/i.test(error)) emptyEl.append(error);
  }

  function refresh() {
    if (loading) return;
    loading = true;
    refreshBtn.classList.add("spinning");
    chrome.runtime.sendMessage({ type: "sessions", limit: LIMIT }, (res) => {
      loading = false;
      refreshBtn.classList.remove("spinning");
      const error = chrome.runtime.lastError?.message || (!res?.ok && (res?.error || "no response"));
      if (error) return showError(error);
      fetchedAt = Date.now();
      statusEl.textContent = "";
      statusEl.title = "";
      render(res.sessions);
      chrome.storage.local.set({ recentSessions: { at: fetchedAt, sessions: res.sessions } });
    });
  }

  refreshBtn.addEventListener("click", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - fetchedAt > STALE_AFTER) refresh();
  });

  // Instant paint from cache, then fetch fresh data.
  chrome.storage.local.get("recentSessions", ({ recentSessions }) => {
    if (recentSessions?.sessions && !listEl.children.length) render(recentSessions.sessions);
    refresh();
  });
})();
