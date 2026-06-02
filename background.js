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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "kill" && typeof msg.port === "number") {
    killPort(msg.port).then(sendResponse);
    return true;
  }
});
