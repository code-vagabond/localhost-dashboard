// Daily notes panel on the new tab page (a contenteditable; pasted links become chips). Every day gets its own note, stored in
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
  const PLACEHOLDER = notesEl.dataset.placeholder;
  const HOST = "com.linh.localhost_dashboard";
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

  // ---------- editor: a contenteditable that reads/writes plain text ----------
  // Links are stored as markdown, "[Title](https://…)", and shown as link chips: one
  // non-editable unit, so Backspace removes the whole link. Lines are <div>s.
  const LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g;
  const site = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

  function chip(url, title, icon) {
    const a = document.createElement("a");
    a.className = "nlink";
    a.href = url;
    a.contentEditable = "false";
    a.title = url;
    a.dataset.title = title || "";
    const img = document.createElement("img");
    img.alt = "";
    img.onerror = () => img.remove();
    img.src = icon || new URL("/favicon.ico", url).href;
    const t = document.createElement("span");
    t.textContent = title || site(url);
    a.append(img, t);
    return a;
  }

  function setText(text) {
    const lines = (text || "").split("\n");
    notesEl.replaceChildren(...lines.map((line) => {
      const div = document.createElement("div");
      let last = 0;
      for (const m of line.matchAll(LINK_RE)) {
        if (m.index > last) div.append(line.slice(last, m.index));
        div.append(chip(m[2], m[1]));
        last = m.index + m[0].length;
      }
      if (last < line.length) div.append(line.slice(last));
      if (!div.childNodes.length) div.append(document.createElement("br"));
      return div;
    }));
    markEmpty();
  }

  function getText() {
    const ser = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.data.replace(/\u00a0/g, " ");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      if (node.classList.contains("nlink")) {
        const title = (node.dataset.title || node.textContent).replace(/[\[\]\n]/g, " ").trim();
        return `[${title}](${node.getAttribute("href")})`;
      }
      if (node.tagName === "BR") return "\n";
      const kids = [...node.childNodes];
      if (/^(DIV|P)$/.test(node.tagName) && kids.length && kids[kids.length - 1].tagName === "BR") kids.pop();
      const inner = kids.map(ser).join("");
      return /^(DIV|P)$/.test(node.tagName) ? "\n" + inner : inner;
    };
    const top = [...notesEl.childNodes];
    // drop the editor's trailing placeholder <br> (and empty text nodes around it)
    const tail = (n) => n && (n.nodeName === "BR" || (n.nodeType === Node.TEXT_NODE && !n.data));
    while (tail(top[top.length - 1])) top.pop();
    const out = top.map(ser).join("");
    return out.startsWith("\n") && /^(DIV|P)$/.test(notesEl.firstChild?.tagName || "") ? out.slice(1) : out;
  }

  const phEl = document.getElementById("notes-ph");
  function markEmpty() {
    const empty = !notesEl.textContent && !notesEl.querySelector(".nlink");
    notesEl.classList.toggle("is-empty", empty);
    phEl.hidden = !empty;
    phEl.textContent = notesEl.dataset.placeholder || "";
  }

  function changed() {
    markEmpty();
    setStatus("editing", "Editing…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  // Paste: a lone URL becomes a link chip (title fetched by the native helper);
  // anything else goes in as plain text, never as formatted HTML.
  notesEl.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    const url = text.trim();
    if (/^https?:\/\/\S+$/.test(url) && !/\s/.test(url)) insertLink(url);
    else document.execCommand("insertText", false, text);
  });

  function insertLink(url) {
    const sel = getSelection();
    if (!sel.rangeCount || !notesEl.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const a = chip(url, "");
    a.classList.add("loading");
    const space = document.createTextNode(" ");
    range.insertNode(space);
    range.insertNode(a);
    range.setStartAfter(space);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    changed();
    chrome.runtime.sendNativeMessage?.(HOST, { type: "title", url }, (res) => {
      a.classList.remove("loading");
      if (chrome.runtime.lastError || !res?.ok) return;
      if (res.title) { a.dataset.title = res.title; a.querySelector("span").textContent = res.title; }
      if (res.icon) { const img = a.querySelector("img") || a.insertBefore(document.createElement("img"), a.firstChild); img.src = res.icon; }
      a.title = `${res.title ? res.title + "\n" : ""}${url}`;
      changed();
    });
  }

  // Links open in a new tab (a contenteditable won't follow them on its own).
  notesEl.addEventListener("click", (e) => {
    const a = e.target.closest(".nlink");
    if (!a) return;
    e.preventDefault();
    window.open(a.getAttribute("href"), "_blank", "noopener");
  });

  // Save the textarea into the day it belongs to. Empty notes are removed
  // so the day list only shows days you actually wrote something.
  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const key = PREFIX + current;
    const text = getText();
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
    writeFile(current, text);
  }

  // Mirror each day's note to ~/notes/YYYY-MM-DD.md (native helper) so other tools,
  // e.g. Claude Code, can read it. Empty notes get no file (clearing one removes it).
  function writeFile(date, text) {
    chrome.runtime.sendNativeMessage?.(HOST, { type: "note-save", date, text }, () => void chrome.runtime.lastError);
  }
  // Catch-up on every new tab: write any stored note whose file is missing or stale
  // (e.g. a write cut off by a closing tab). Never deletes files.
  chrome.storage.local.get(null, (items) => {
    const notes = {};
    for (const [k, v] of Object.entries(items)) if (k.startsWith(PREFIX) && String(v).trim()) notes[k.slice(PREFIX.length)] = v;
    if (Object.keys(notes).length) chrome.runtime.sendNativeMessage?.(HOST, { type: "notes-sync", notes }, () => void chrome.runtime.lastError);
  });

  notesEl.addEventListener("input", changed);
  // Flush a pending save if the tab is closed mid-typing.
  window.addEventListener("pagehide", () => { if (saveTimer) save(); });
  // Save straight away when you leave the notes or the tab — earlier than pagehide,
  // while there's still time for the write (and the file) to finish.
  notesEl.addEventListener("blur", () => { if (saveTimer) save(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) save(); });

  // --- switch the panel to a given day ---
  function openDay(key) {
    if (saveTimer) save(); // pending typing belongs to the day it was typed on
    current = key;
    renderHeading();
    setStatus("", "");
    chrome.storage.local.get(PREFIX + key, (items) => {
      if (current !== key) return; // switched again meanwhile
      setText(items[PREFIX + key] || "");
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
    if (nextBtn) nextBtn.disabled = !past;
    notesEl.dataset.placeholder = past ? "Nothing written this day." : PLACEHOLDER;
    markEmpty();
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

  // ‹ › step one calendar day back / forward (never past today).
  const prevBtn = document.getElementById("day-prev"), nextBtn = document.getElementById("day-next");
  function shiftDay(n) {
    const d = keyDate(current);
    d.setDate(d.getDate() + n);
    const key = dayKey(d);
    if (key > today) return;
    openDay(key);
  }
  prevBtn.addEventListener("click", () => shiftDay(-1));
  nextBtn.addEventListener("click", () => shiftDay(1));

  toTodayBtn.addEventListener("click", () => {
    openDay(today);
    notesEl.focus();
  });

  // --- day dropdown ---
  let options = []; // option buttons, in display order
  let active = -1;  // keyboard-highlighted option

  function firstLine(text) {
    const line = text.replace(LINK_RE, "$1").split("\n").map((l) => l.trim()).find(Boolean) || "";
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
      if (next !== getText()) setText(next);
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
      setText(merged);
    } else {
      setText(items[PREFIX + today] || "");
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
      const r = document.createRange();
      r.selectNodeContents(notesEl);
      r.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }
  });
})();
