# 🛰️ Localhost Dashboard

A Chrome extension that scans your localhost ports and shows a **live desktop preview** of whatever is running on each one — plus a quick action to kill a port.

![new tab override](https://img.shields.io/badge/newtab-override-blue) ![manifest v3](https://img.shields.io/badge/manifest-v3-green)

## Features

- **Port scan** — probes a list/range of ports and shows a card for each live service.
- **App info** — each card shows the page title, favicon, meta description and detected framework (one plain GET, no rendering), plus the project folder and start command from the native host. **Live previews** (the app embedded at 1280px desktop width) are optional in Settings — heavier, since each one runs the whole app.
- **Trams nearby** — next BVG tram departures from the closest stops (current location, or a stop/address set with the ✎ button or in Settings).
- **Health** — last night's sleep (total, bed/wake, stages) and 7-day sleep / HRV / resting-HR trends from Fitbit / Google Health, read through the native host (`native/health.js`, needs the health-agent CLI at `~/code/health-agent`). Cached; refreshes when older than 30 minutes.
- **Click to open** — click a card's header bar to open that app in the current tab.
- **Daily notes** — a plain-text note per day (left panel). A fresh note opens automatically each new day; click the date to open past days. Autosaved and synced across tabs.
- **Recent sessions** — the 7 latest sessions from Claude Code, Claude Desktop (Code tab + Cowork), Codex, Cursor CLI and the Cursor app, with title, first prompt, project and time. Click a row to copy its resume command (`claude --resume …`, `codex resume …`, `cursor-agent --resume …`) and bring Ghostty to the front, ready to paste; Claude Desktop / Cursor rows copy the prompt and bring that app forward. Read from local history files by the native host *(regular Claude Desktop chats live in the cloud and aren't included)*. Run `node native/sessions.js` to see what it finds.
- **⏻ Kill port** — terminate the process listening on a port, straight from the dashboard *(requires the one-time native host setup below)*.

---

## 1. Install the extension

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder (`localhost-dashboard/`).
4. Copy the **extension ID** shown on the card (a long string like `bcbidfoelnbfcgjajfcnpaaablibcdfi`) — you'll need it for the kill feature.

The dashboard opens automatically on every **new tab**, or click the toolbar icon.

> **Usage:** edit the ports/ranges on the **Settings** page (sliders icon, e.g. `3000-3010, 5173, 8080`), hit **Rescan** (or press `R`). Turn on **Auto-refresh** to rescan every 10s — cards for ports that stay up are kept, so previews don't reload.

---

## 2. Enable the "Kill port" feature (optional, one-time)

Browser extensions are sandboxed and **cannot run OS commands** on their own. To kill a process, the extension talks to a tiny **native messaging host** (a local Node script) that runs `lsof` + `kill`. You register it once.

### Requirements
- **Node.js** installed (the installer bakes your current `node` path into the launcher, so nvm is fine).
- macOS (paths below are macOS Chrome; see *Other browsers/OSes*).

### Setup
From the project folder, run the installer with **your** extension ID from step 1.4:

```bash
./native/install.sh <EXTENSION_ID>
```

Example:

```bash
./native/install.sh bcbidfoelnbfcgjajfcnpaaablibcdfi
```

This:
- generates `native/run.sh` with the **absolute path to your node** (Chrome launches native hosts with a minimal `PATH` that excludes nvm),
- writes the host manifest to
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.linh.localhost_dashboard.json`,
- locks it to your extension ID via `allowed_origins`.

### Finish
1. Reload the extension at `chrome://extensions`.
2. Open the dashboard — each card has a **⏻** (power) button.
3. Click ⏻ → confirm → the port's process is killed (`SIGTERM`) and the card disappears.

> If you switch Node versions (nvm), just re-run `./native/install.sh <EXTENSION_ID>` to refresh the baked node path.

---

## Usage cheatsheet

| Action | How |
|--------|-----|
| Rescan ports | Click **Rescan** or press `R` |
| Edit port list | Sliders icon → Settings (`⌘/Ctrl+Enter` saves) |
| Open an app | Click the card's **header bar** (current tab); `⌘/Ctrl`- or middle-click for a new tab |
| Copy a URL | Click the **copy** icon on the card (copies `http://localhost:PORT/`) |
| Kill a port | Click **⏻** on the card (needs native host) |
| Auto-refresh | Toggle **Auto-refresh** (every 10s) |
| Notes | Press `N` to jump into notes, `Esc` to leave; click the date for past days (↑↓ Enter) |

---

## Troubleshooting

**⏻ says "Specified native messaging host not found"**
Chrome hasn't picked up the manifest. Fully **quit and reopen Chrome**, then reload the extension.

**⏻ says "is the native host installed?"**
You haven't run `./native/install.sh <EXTENSION_ID>` yet, or the extension ID in the manifest doesn't match. Re-run the installer with the correct ID and reload.

**⏻ does nothing / node error**
The installer couldn't find `node`. Run it from a shell where `node -v` works, or re-run after `nvm use`.

**"Can't embed (X-Frame-Options / CSP)" overlay on a card**
That app sends headers forbidding iframe embedding, so it can't be previewed. (The overlay only appears if the iframe doesn't load within 3.5s.) Click the card header to open it in a tab instead.

**A killed dev server won't die**
The host sends `SIGTERM` (graceful). Some servers ignore it — ask to switch to a `SIGTERM → SIGKILL` fallback.

---

## File structure

```
localhost-dashboard/
├── manifest.json          # MV3 manifest (storage, tabs, nativeMessaging)
├── theme.css              # Shared colors (dark + light), controls, focus styles
├── dashboard.html         # Dashboard UI + styles (new tab page)
├── dashboard.js           # Scan, preview, kill UI logic
├── notes.js               # Daily notes: per-day storage, day picker, autosave + cross-tab sync
├── settings.html / .js    # Port-list settings page
├── recent.js              # Recent AI sessions list (cached, refreshed on tab focus)
├── background.js          # Service worker: routes kill + sessions requests to the native host
├── native/
│   ├── kill_port.js       # Native messaging host — kill ports, answer sessions requests
│   ├── sessions.js        # Reads Claude/Codex/Cursor session history from local files
│   ├── install.sh         # Registers the host with Chrome + Edge (run once)
│   └── run.sh             # Auto-generated launcher (absolute node path)
└── README.md
```

---

## Other browsers / OSes

The native host manifest path is browser- and OS-specific. `install.sh` registers it for **Google Chrome and Microsoft Edge on macOS**:
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
`~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/`

For Chromium, Brave, or Linux/Windows, the host JSON is identical but the directory differs — see [Chrome native messaging docs](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location). Add it to `TARGET_DIRS` in `install.sh`.

---

## Security notes

- The native host only accepts messages from **your** extension ID (`allowed_origins`) and only acts on a `port` number → `lsof` → `kill`. It runs locally with your user permissions.
- Everything stays on your machine; no network calls leave localhost.
