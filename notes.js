// Daily notes panel on the new tab page. Every day gets its own note, stored in
// extension storage as "note:YYYY-MM-DD". The date heading is a dropdown for
// opening past days; a fresh note opens automatically when the day rolls over.
// Edits autosave and stay in sync across every open dashboard tab.
(() => {
  const notesEl = document.getElementById("notes");
  const notesStatus = document.getElementById("notes-status");
  const notesLabel = document.getElementById("notes-label");
  const dayBtn = document.getElementById("day-btn");
  const dayMenu = document.getElementById("day-menu");
  const toTodayBtn = document.getElementById("to-today");
  const SAVE_DELAY = 400; // ms after the last keystroke
  const PREFIX = "note:";
  const PLACEHOLDER = notesEl.placeholder;
  let saveTimer = null;
  let today = dayKey(new Date());
  let current = today; // the day whose note is in the textarea

  // --- dates: local calendar day <-> "YYYY-MM-DD" ---
  function dayKey(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function keyDate(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function relativeName(key) {
    if (key === today) return "Today";
    const yesterday = new Date(keyDate(today));
    yesterday.setDate(yesterday.getDate() - 1);
    return key === dayKey(yesterday) ? "Yesterday" : "";
  }

  // Small "Editing… / Saved 20:41 / Not saved" indicator; data-state drives the styling.
  function setStatus(state, text) {
    notesStatus.dataset.state = state;
    notesStatus.textContent = text;
  }

  // Save the textarea into the day it belongs to. Empty notes are removed
  // so the day list only shows days you actually wrote something.
  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const key = PREFIX + current;
    const text = notesEl.value;
    const done = () => {
      if (chrome.runtime.lastError) {
        setStatus("error", `Not saved: ${chrome.runtime.lastError.message}`);
      } else {
        const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        setStatus("saved", `Saved ${time}`);
      }
    };
    if (text.trim()) chrome.storage.local.set({ [key]: text }, done);
    else chrome.storage.local.remove(key, done);
  }

  notesEl.addEventListener("input", () => {
    setStatus("editing", "Editing…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  });
  // Flush a pending save if the tab is closed mid-typing.
  window.addEventListener("pagehide", () => { if (saveTimer) save(); });

  // --- switch the panel to a given day ---
  function openDay(key) {
    if (saveTimer) save(); // pending typing belongs to the day it was typed on
    current = key;
    renderHeading();
    setStatus("", "");
    chrome.storage.local.get(PREFIX + key, (items) => {
      if (current !== key) return; // switched again meanwhile
      notesEl.value = items[PREFIX + key] || "";
    });
  }

  // Heading ("THURSDAY" / "24 September"), plus the past-day cues.
  function renderHeading() {
    const date = keyDate(current);
    const past = current !== today;
    const rel = relativeName(current);
    document.getElementById("notes-weekday").textContent =
      (rel && past ? `${rel} · ` : "") + date.toLocaleDateString(undefined, { weekday: "long" });
    document.getElementById("notes-date").textContent = date.toLocaleDateString(undefined, {
      day: "numeric", month: "long",
      ...(date.getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
    });
    dayBtn.classList.toggle("past", past);
    notesEl.classList.toggle("past", past);
    toTodayBtn.hidden = !past;
    notesEl.placeholder = past ? "Nothing written this day." : PLACEHOLDER;
    notesLabel.textContent = past ? `Notes for ${date.toDateString()}` : "Today's notes";
  }

  // New day: move "today" forward. If you were looking at the old today,
  // follow it to the fresh note; if you were browsing the past, stay put.
  function checkDayChange() {
    const now = dayKey(new Date());
    if (now === today) return;
    const wasOnToday = current === today;
    today = now;
    if (wasOnToday) openDay(today);
    else renderHeading();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkDayChange(); });
  setInterval(checkDayChange, 60 * 1000);

  toTodayBtn.addEventListener("click", () => {
    openDay(today);
    notesEl.focus();
  });

  // --- day dropdown ---
  let options = []; // option buttons, in display order
  let active = -1;  // keyboard-highlighted option

  function firstLine(text) {
    const line = text.split("\n").map((l) => l.trim()).find(Boolean) || "";
    return line.replace(/^[-*•]\s*(\[[ xX]\]\s*)?/, "");
  }

  function buildMenu(items) {
    const days = Object.keys(items)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length))
      .filter((k) => k !== today && items[PREFIX + k].trim())
      .sort()
      .reverse();
    // Today always sits at the top, even while it's still empty.
    const all = [today, ...days];

    dayMenu.innerHTML = "";
    options = [];
    let lastGroup = "";
    for (const key of all) {
      const date = keyDate(key);
      const group = key === today ? "" : date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      if (group && group !== lastGroup) {
        const g = document.createElement("div");
        g.className = "day-group";
        g.textContent = group;
        dayMenu.appendChild(g);
        lastGroup = group;
      }
      const text = items[PREFIX + key] || "";
      const rel = relativeName(key);
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "day-option";
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(key === current));
      opt.dataset.key = key;
      opt.innerHTML = `
        <span class="num"><small></small></span>
        <span class="name"></span>
        <span class="snippet"></span>`;
      opt.querySelector(".num small").textContent = date.toLocaleDateString(undefined, { month: "short" });
      opt.querySelector(".num").append(String(date.getDate()));
      opt.querySelector(".name").textContent = date.toLocaleDateString(undefined, { weekday: "long" });
      if (rel) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = `· ${rel}`;
        opt.querySelector(".name").append(" ", tag);
      }
      opt.querySelector(".snippet").textContent = firstLine(text) || "Empty so far";
      opt.addEventListener("click", () => {
        closeMenu();
        openDay(key);
        notesEl.focus();
      });
      dayMenu.appendChild(opt);
      options.push(opt);
    }
    if (!days.length) {
      const empty = document.createElement("div");
      empty.className = "day-empty";
      empty.textContent = "Past days show up here once you've written in them.";
      dayMenu.appendChild(empty);
    }
  }

  function setActive(i) {
    options[active]?.classList.remove("active");
    active = Math.max(0, Math.min(options.length - 1, i));
    options[active]?.classList.add("active");
    options[active]?.scrollIntoView({ block: "nearest" });
  }

  function openMenu() {
    if (saveTimer) save(); // so the list shows what you just typed
    chrome.storage.local.get(null, (items) => {
      buildMenu(items);
      dayMenu.hidden = false;
      dayBtn.setAttribute("aria-expanded", "true");
      setActive(options.findIndex((o) => o.dataset.key === current));
    });
  }
  function closeMenu() {
    dayMenu.hidden = true;
    dayBtn.setAttribute("aria-expanded", "false");
    active = -1;
  }

  dayBtn.addEventListener("click", () => (dayMenu.hidden ? openMenu() : closeMenu()));
  document.addEventListener("pointerdown", (e) => {
    if (!dayMenu.hidden && !e.target.closest(".day-picker")) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (dayMenu.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeMenu(); dayBtn.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter" && options[active]) { e.preventDefault(); options[active].click(); }
  }, true);

  // Pick up edits made in another tab — unless this tab has unsaved typing.
  chrome.storage.onChanged.addListener((changes, area) => {
    const change = changes[PREFIX + current];
    if (area === "local" && change && !saveTimer) {
      const next = change.newValue || "";
      if (next !== notesEl.value) notesEl.value = next;
    }
  });

  // One-time migration: the old single "notes" note becomes today's note
  // (or is prepended to it, if today's note already has text).
  chrome.storage.local.get(["notes", PREFIX + today], (items) => {
    const legacy = items.notes;
    if (legacy && legacy.trim()) {
      const existing = items[PREFIX + today] || "";
      const merged = !existing ? legacy
        : existing.includes(legacy) ? existing // another tab already migrated
        : `${legacy}\n\n${existing}`;
      chrome.storage.local.set({ [PREFIX + today]: merged }, () => {
        chrome.storage.local.remove("notes");
      });
      notesEl.value = merged;
    } else {
      notesEl.value = items[PREFIX + today] || "";
      if (legacy !== undefined) chrome.storage.local.remove("notes");
    }
  });
  renderHeading();

  // Keyboard: N jumps into the notes (cursor at the end), Esc leaves them.
  // Ignored while typing elsewhere or with a modifier held (no browser-shortcut clashes).
  document.addEventListener("keydown", (e) => {
    if (e.target === notesEl) {
      if (e.key === "Escape") notesEl.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      notesEl.focus();
      notesEl.setSelectionRange(notesEl.value.length, notesEl.value.length);
    }
  });
})();
