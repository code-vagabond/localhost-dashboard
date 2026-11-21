// Keep in sync with the default in dashboard.js.
const DEFAULT_PORTS =
  // Common dev-server ports: Node/Next/Rails (3000s), Vite (5173+), Angular (4200),
  // Astro (4321), Storybook (6006), Gradio (7860), Django/Python (8000s), Hugo (1313)…
  "1234, 1313, 2000-2100, 3000-3200, 3300-3310, 3456, 4000-4010, 4200-4210, 4321, " +
  "4400-4410, 5000-5010, 5173-5190, 5500-5510, 6006, 7000-7010, 7860, 8000-8100, " +
  "8443, 8787, 8888-8890, 9000-9010";

const $ = (id) => document.getElementById(id);
const portsInput = $("ports");
const savedEl = $("saved");
const countEl = $("port-count");

// Same parsing as dashboard.js (kept in sync), used here only for the live count.
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

// "520 ports will be scanned" under the field, updated as you type.
function updateCount() {
  const n = parsePorts(portsInput.value || DEFAULT_PORTS).length;
  countEl.textContent = n
    ? `${n} port${n === 1 ? "" : "s"} will be scanned`
    : "No valid ports — the defaults will be used";
  countEl.classList.toggle("warn", !n);
}

function flashSaved() {
  savedEl.classList.add("show");
  setTimeout(() => savedEl.classList.remove("show"), 2200);
}

function save() {
  chrome.storage?.local.set({ ports: portsInput.value }, flashSaved);
}

$("save").addEventListener("click", save);
portsInput.addEventListener("input", updateCount);
portsInput.addEventListener("keydown", (e) => {
  // Cmd/Ctrl+Enter saves (plain Enter would just add a newline in the textarea).
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    save();
  }
});
$("reset").addEventListener("click", () => {
  portsInput.value = DEFAULT_PORTS;
  updateCount();
  save();
});

// Load the saved port list.
chrome.storage?.local.get("ports", ({ ports }) => {
  portsInput.value = ports || DEFAULT_PORTS;
  updateCount();
});

// Tram location (stop or address); empty = browser geolocation.
const tramInput = $("tram-location");
function saveTram() {
  chrome.storage?.local.set({ tramLocation: tramInput.value.trim() }, () => {
    $("saved-tram").classList.add("show");
    setTimeout(() => $("saved-tram").classList.remove("show"), 2200);
  });
}
$("save-tram").addEventListener("click", saveTram);
tramInput.addEventListener("keydown", (e) => e.key === "Enter" && saveTram());
chrome.storage?.local.get("tramLocation", ({ tramLocation }) => {
  tramInput.value = tramLocation || "";
});

// Live previews toggle (off = light info cards).
const previewsBox = $("previews");
previewsBox.addEventListener("change", () => chrome.storage?.local.set({ previews: previewsBox.checked }));
chrome.storage?.local.get("previews", ({ previews }) => { previewsBox.checked = !!previews; });
