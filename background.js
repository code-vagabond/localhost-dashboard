// Open the dashboard in a full tab when the toolbar icon is clicked.
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  // Reuse an existing dashboard tab if one is already open.
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});

// Native messaging host that kills the process holding a port.
// Registered via native/install.sh (see that file for setup).
const NATIVE_HOST = "com.linh.localhost_dashboard";

function killPort(port) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { port }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error:
            chrome.runtime.lastError.message +
            " — is the native host installed? (run native/install.sh)",
        });
      } else {
        resolve(res || { ok: false, error: "no response from host" });
      }
    });
  });
}

// Recent Claude Code / Claude Desktop / Codex / Cursor sessions, read by the native host.
function recentSessions(limit) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "sessions", limit }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: "no response from host" });
      }
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "focus") {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "focus", app: msg.app, path: msg.path }, (res) => {
      sendResponse(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
    });
    return true;
  }
  if (msg?.type === "ports" && Array.isArray(msg.ports)) {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "ports", ports: msg.ports }, (res) => {
      sendResponse(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res);
    });
    return true;
  }
  // Sleep / HRV / resting HR from the health-agent CLI (native/health.js).
  if (msg?.type === "health") {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "health", days: msg.days || 7 }, (res) => {
      sendResponse(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res || { ok: false, error: "no response from host" });
    });
    return true;
  }
  if (msg?.type === "sessions") {
    recentSessions(msg.limit || 7).then(sendResponse);
    return true;
  }
  if (msg?.type === "kill" && typeof msg.port === "number") {
    killPort(msg.port).then(sendResponse);
    return true;
  }
});
