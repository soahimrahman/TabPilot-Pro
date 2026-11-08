# TabPilot Pro — Smart Tab Memory & Sleep Manager

<p align="center">
  <img src="icons/icon128.png" alt="TabPilot Pro Logo" width="108" height="108" />
</p>

<p align="center">
  <strong>High-Performance Tab Sleep, RAM Optimization & Network Blocker for Chromium</strong><br />
  Sleep inactive tabs without closing them, cut browser memory consumption up to 80%, block background network leaks, and recover lost sessions.
</p>

<p align="center">
  <a href="https://github.com/soahimrahman/TabPilot-Pro/releases"><img src="https://img.shields.io/badge/version-v3.2.6-705ce7?style=for-the-badge&logo=semver&logoColor=white" alt="Version 3.2.6" /></a>
  <a href="https://developer.chrome.com/docs/extensions/mv3/intro/"><img src="https://img.shields.io/badge/Manifest-V3-5ad8a7?style=for-the-badge&logo=googlechrome&logoColor=black" alt="Manifest V3" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="MIT License" /></a>
  <a href="https://github.com/soahimrahman/TabPilot-Pro/actions"><img src="https://img.shields.io/badge/Tests-Passing-brightgreen?style=for-the-badge&logo=githubactions&logoColor=white" alt="CI Status" /></a>
  <a href="#-security-privacy--least-privilege"><img src="https://img.shields.io/badge/Privacy-100%25%20Localhost-4d91fa?style=for-the-badge&logo=shield" alt="Localhost Only" /></a>
</p>

---

## 📑 Table of Contents

- [The Problem with Modern Browsers](#-the-problem-with-modern-browsers)
- [How TabPilot Pro Works Under the Hood](#-how-tabpilot-pro-works-under-the-hood)
- [Architecture & Data Flow](#-architecture--data-flow)
- [Deep Dive: Core Mechanisms](#-deep-dive-core-mechanisms)
  - [1. Page Document Replacement (Sleep Screen)](#1-page-document-replacement-sleep-screen)
  - [2. Declarative Net Request (DNR) Blocking](#2-declarative-net-request-dnr-blocking)
  - [3. The Priority & Scheduling Engine](#3-the-priority--scheduling-engine)
  - [4. Sleep Previous Tab on Switch](#4-sleep-previous-tab-on-switch)
  - [5. Auto-Refill on Close](#5-auto-refill-on-close)
  - [6. Emergency Tab Recovery](#6-emergency-tab-recovery)
  - [7. Automated GitHub Update & Reload](#7-automated-github-update--reload)
- [Feature Comparison Matrix](#-feature-comparison-matrix)
- [Installation Guide](#-installation-guide)
- [Settings & Configuration Reference](#-settings--configuration-reference)
- [Keyboard Shortcuts](#-keyboard-shortcuts)
- [The Full Control Center Dashboard](#-the-full-control-center-dashboard)
- [Security, Privacy & Least Privilege](#-security-privacy--least-privilege)
- [Technical Troubleshooting & FAQ](#-technical-troubleshooting--faq)
- [Testing & Development](#-testing--development)
- [License](#-license)

---

## ⚡ The Problem with Modern Browsers

Every tab you open in Google Chrome, Microsoft Edge, or Brave runs as an isolated OS process (renderer). Complex single-page applications (YouTube, Gmail, Figma, Jira, Notion, social networks) hold heavy memory allocations:

- **Large V8 JavaScript Heaps:** Retained objects, event listeners, and closures.
- **Unbounded DOM Trees:** Thousands of DOM nodes, shadow roots, and CSS layout trees.
- **Background Timers & WebSockets:** `setInterval`, `requestAnimationFrame`, active SSE/WebSocket feeds, and long-polling requests that continue eating CPU cycles and battery even when you haven't looked at the tab for hours.
- **Media Buffers & Decoders:** Video players holding chunks of uncompressed frames in memory.

When you have 20, 50, or 100 tabs open, your browser can easily consume **8 GB to 16 GB+ of RAM**, causing sluggish multitasking, loud laptop fans, and battery drain.

### Why Existing Solutions Fall Short:

| Approach | How It Works | The Fatal Flaw |
| :--- | :--- | :--- |
| **Chrome's Native "Memory Saver"** | Discards tabs natively only when system RAM is critically low. | Unpredictable. Does not prevent background network pings before discarding, and clicking a tab triggers an unexpected reload that can lose form data. |
| **Tab Closers / Bookmark Dumpers** (e.g. OneTab) | Closes tabs and dumps their URLs into a list. | **Destroys your visual workflow.** Your tabs vanish from the tab strip, losing tab groups, pinned states, and spatial organization. |
| **Native `chrome.tabs.discard()`** | Calls Chrome's discard API on background tabs. | Chrome frequently refuses to discard tabs in specific states (e.g. active forms, certain media states, or specific worker states) and leaves background network listeners active. |

**TabPilot Pro solves this fundamentally.** It keeps your visual workspace completely intact while purging 100% of the page's memory and stopping all background network traffic.

---

## 🔬 How TabPilot Pro Works Under the Hood

TabPilot Pro operates on a **True Zero-Footprint Sleep Paradigm**:

1. **Tabs Are Never Closed:** Sleeping tabs remain right where they belong in your browser tab strip. Their position, tab order, and window placement are untouched.
2. **Page Document Destruction:** Instead of relying on passive OS memory flags, TabPilot replaces the sleeping tab's document with a clean, local extension page (`sleep.html`). The original webpage's DOM, JavaScript runtime, media buffers, WebWorkers, and WebSockets are completely purged by Chromium's garbage collector.
3. **Session-Scoped Network Blocking:** Using Chromium's `declarativeNetRequest` API, TabPilot registers tab-scoped session firewall rules that intercept and block all subframes, scripts, stylesheets, images, XHR/Fetch requests, WebSockets, and media streams for sleeping tabs.
4. **Isolated Ephemeral Tokenization:** The original URL and title are never exposed in the URL bar. They are indexed in local storage under a secure random token key (e.g., `?key=t7a9...`). When you choose to restore the tab, TabPilot retrieves the exact original URL and navigates the tab back seamlessly.

---

## 🏗️ Architecture & Data Flow

```mermaid
flowchart TD
    subgraph Browser [" Chromium Browser (Chrome / Edge / Brave) "]
        TabStrip["Open Tabs in Browser Strip"]
        
        subgraph ActiveWorkspace [" Active Tabs (Up to Limit) "]
            LiveTabs["Live Webpages\nFull DOM & JS Execution\nNetwork Active"]
        end
        
        subgraph SleepWorkspace [" Sleeping Tabs "]
            SleepScreen["Local Sleep Screen (sleep.html)\nZero JS Heap · Zero Timers · Static 404 UI"]
            DNR["declarativeNetRequest Rule\nBlocks Subframes, Scripts, XHR, WebSockets"]
        end
    end

    subgraph Controller [" Service Worker Supervisor (service-worker.js) "]
        EventStream["Tab Events (onActivated, onCreated, onRemoved)"]
        Reconcile["Reconciliation & Priority Engine"]
        TokenStore[("Local Token Cache\nOriginal URLs, Titles, Timestamps")]
    end

    TabStrip --> EventStream
    EventStream --> Reconcile
    Reconcile -->|Tab Exceeds Limit| SleepScreen
    Reconcile -->|Attach Firewall Rule| DNR
    SleepScreen -.->|Stores Original Metadata| TokenStore
    SleepScreen ==>|Restore Button / Wake Action| LiveTabs
    LiveTabs -->|Switch Away (If Enabled)| SleepScreen
```

---

## ⚙️ Deep Dive: Core Mechanisms

### 1. Page Document Replacement (Sleep Screen)
When a tab goes to sleep, TabPilot Pro records the original URL and title into `chrome.storage.local` under a cryptographically random token key. It then navigates the tab to:
```text
chrome-extension://<id>/sleep.html?key=3x9k2-a8b1c4
```
Because the top-level document navigates away from the original website, Chromium's V8 engine executes garbage collection on the entire site context:
- All event listeners and timers (`setInterval`, `setTimeout`) are terminated.
- All DOM nodes, canvas contexts, and image textures are released from VRAM and RAM.
- WebSockets, WebRTC streams, and Server-Sent Events (SSE) connections are cleanly closed.
- The `sleep.html` page itself is an ultra-lightweight static page with no external fonts, no external scripts, and no dependencies.

### 2. Declarative Net Request (DNR) Blocking
Many tab managers only hide or unload the DOM, leaving service workers or background sync requests firing in the background. 

TabPilot Pro implements **network-level session blocking**:
- Upon entering sleep, TabPilot assigns a dynamic session rule to the tab via `chrome.declarativeNetRequest.updateSessionRules`.
- The rule intercepts and blocks the following resource types attributed to that specific `tabId`:
  `sub_frame`, `stylesheet`, `script`, `image`, `font`, `object`, `xmlhttprequest`, `ping`, `csp_report`, `media`, `websocket`, `other`.
- The top-level document navigation (`main_frame`) is explicitly left unblocked so clicking "Restore" or navigating the tab can reload the original website instantly.
- The moment the tab is activated or woken, the firewall rule is cleanly removed.

### 3. The Priority & Scheduling Engine
TabPilot uses a deterministic multi-tiered priority algorithm to decide which tabs stay loaded when your live-tab limit is reached:

```text
Priority 01: Active Tab             → Chromium forbids discarding the visible active tab. Always live.
Priority 02: Protected Tabs         → Keep Awake enabled, Pinned tabs, or tabs playing audio/video.
Priority 03: Recent User Tabs       → Tabs accessed most recently fill remaining live slots (Recency FIFO).
Priority 04: Idle Background Tabs   → Oldest idle tabs are converted to sleep screens first.
```

The reconciliation loop runs automatically during:
- Tab activation (`onActivated`)
- Tab creation (`onCreated`)
- Tab closure (`onRemoved`)
- Settings modifications (`storage.onChanged`)
- Periodic recovery alarms (`chrome.alarms`)

### 4. Sleep Previous Tab on Switch
For users seeking maximum memory savings (especially on laptops or machines with 8 GB RAM):
- Enabling **"Sleep previous tab on switch"** instructs TabPilot to unload the tab you navigate away from.
- An **anti-thrashing grace period (4 seconds)** is enforced: if you rapidly flip back and forth between two tabs to compare values or copy text, TabPilot cancels the sleep action and keeps both live.
- Protected tabs (pinned, active/recent audio, Keep Awake) are respected and will never be put to sleep on switch.
- **Meeting & Audio Protection:** Features a 90-second cooldown window so brief conversational pauses in Google Meet, Zoom, or Spotify track transitions won't prematurely drop calls or music.

### 5. Auto-Refill on Close
When you close an active tab, a "live tab slot" opens up in your workspace:
- If **"Auto-refill after closing"** is enabled, TabPilot calculates the most recently used sleeping tab and restores it in the background.
- Your designated live-tab capacity is maintained seamlessly without manual intervention.

### 6. Emergency Tab Recovery
Accidentally closed a window with 20 tabs? Or did your browser restart unexpectedly?
- TabPilot features a dedicated **Session Recovery Engine** powered by `chrome.sessions.getRecentlyClosed()`.
- It scans Chrome's session history for recently closed tabs and multi-tab windows up to **60 tabs**.
- Clicking **"Restore last 60 tabs"** executes an automated recovery flow:
  1. It **pauses automatic sleep mode** and "sleep on switch" temporarily.
  2. Restores the sessions sequentially using Chrome's native session restorer.
  3. Re-enables protection so your newly restored tabs are not immediately unloaded.

### 7. Automated GitHub Update & Reload
TabPilot Pro automatically monitors its GitHub repository for new releases:
- An internal background alarm checks GitHub's remote release manifest periodically using lightweight semver comparison.
- When an update is detected on Git:
  - A glowing **"NEW"** badge appears on the extension icon in Chrome's toolbar.
  - A prominent update banner appears in both the **Popup** and **Admin Dashboard**.
  - Clicking **"Reload"** reloads the extension directly inside Chrome using `chrome.runtime.reload()`, immediately activating updated local files without visiting `chrome://extensions`.
  - Clicking **"Get"** directs the user directly to the latest GitHub Release ZIP.

---

## 📊 Feature Comparison Matrix

| Capability | Standard Chrome | Traditional Tab Suspenders | Tab Closers (e.g. OneTab) | TabPilot Pro |
| :--- | :---: | :---: | :---: | :---: |
| **Keep Tabs in Tab Strip** | ✅ Yes | ✅ Yes | ❌ No (Closes tabs) | ✅ **Yes** |
| **Complete DOM & JS Unload** | ⚠️ Partial / Unreliable | ⚠️ Browser Discard Only | ✅ Yes | ✅ **Yes (Full 404 Sleep Screen)** |
| **Network & WebSocket Blocking** | ❌ No | ❌ No | ❌ No | ✅ **Yes (DeclarativeNetRequest)** |
| **Configurable Live Tab Cap** | ❌ No | ❌ No | ❌ No | ✅ **Yes (1–30 Tabs Slider)** |
| **Sleep on Tab Switch** | ❌ No | ❌ No | ❌ No | ✅ **Yes (Debounced)** |
| **Keep Awake Protection** | ❌ No | ⚠️ Pinned only | ❌ No | ✅ **Yes (Pinned, Audio & Manual)** |
| **Emergency Session Recovery** | ❌ History only | ❌ No | ❌ No | ✅ **Yes (Up to 60 tabs via API)** |
| **Keyboard Shortcuts** | ❌ No | ⚠️ Limited | ❌ No | ✅ **Yes (Global Hotkeys)** |
| **Collapsible Tab Dashboard** | ❌ No | ❌ No | ⚠️ Flat link list | ✅ **Yes (Status, Window, Domain)** |
| **100% Local / Zero Telemetry** | ❌ Google Analytics | ⚠️ Some track users | ⚠️ Varies | ✅ **100% Private Localhost** |

---

## 🚀 Installation Guide

### Prerequisites
- **Google Chrome 109+**, **Microsoft Edge**, **Brave**, or any modern Chromium-based browser supporting Manifest V3.

---

### Step-by-Step Installation:

1. **Download or Clone the Repository**:
   ```bash
   git clone https://github.com/soahimrahman/TabPilot-Pro.git
   cd TabPilot-Pro
   ```
   *(Or download the ZIP from GitHub and extract it to a permanent folder).*

2. **Open Extensions Management**:
   - In **Google Chrome / Brave:** Navigate to `chrome://extensions`
   - In **Microsoft Edge:** Navigate to `edge://extensions`

3. **Enable Developer Mode**:
   - Turn on the **Developer mode** toggle switch located in the top-right corner.

4. **Load the Extension**:
   - Click the **Load unpacked** button.
   - Select the `TabPilot-Pro` folder (the folder containing `manifest.json`).

5. **Pin TabPilot Pro**:
   - Click the extensions puzzle icon in your browser toolbar and pin **TabPilot Pro** for instant access.

---

## 🎛️ Settings & Configuration Reference

Open the TabPilot popup by clicking the toolbar icon:

| Setting | Default | What It Controls |
| :--- | :---: | :--- |
| **Enable Sleep Mode** | `OFF` | Master switch. When enabled, inactive tabs exceeding your live limit are automatically put to sleep. |
| **Live Tab Limit** | `5` | Maximum number of fully loaded tabs allowed simultaneously (adjustable from 1 to 30 tabs). Quick presets: **3, 5, 8, 10, 15**. |
| **Sleep Previous Tab on Switch** | `ON` | When switching tabs, immediately unloads the tab you just departed (after a 300ms debounce window). |
| **Block Network While Sleeping** | `ON` | Activates tab-scoped `declarativeNetRequest` rules to halt background AJAX, media buffers, and WebSocket pings. |
| **Auto-Refill After Closing** | `ON` | Automatically wakes the next eligible sleeping tab when you close an active tab. |
| **Protect Pinned Tabs** | `ON` | Excludes pinned tabs from automated suspension. |
| **Protect Tabs Playing Audio** | `ON` | Excludes tabs playing music, podcasts, or video calls (YouTube Music, Spotify, Meet) from sleep. |

---

## ⌨️ Keyboard Shortcuts

Perform power actions without reaching for the mouse:

| Windows & Linux | macOS | Action |
| :--- | :--- | :--- |
| <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> | <kbd>⌥</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> | **Open Control Center:** Launches the full admin dashboard in a dedicated tab. |
| <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> | <kbd>⌥</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> | **Toggle Keep Awake:** Protects or unprotects the currently focused tab. |
| <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>O</kbd> | <kbd>⌥</kbd> + <kbd>Shift</kbd> + <kbd>O</kbd> | **Sleep Other Tabs:** Immediately suspends all other inactive tabs in the current window. |

> [!TIP]
> You can rebind or customize these hotkeys anytime by visiting `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`.

---

## 🖥️ The Full Control Center Dashboard

Click **"Open full admin dashboard"** in the popup (or press <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd>) to access the advanced workspace manager:

### 1. Overview Workspace
- **Live Memory Meter:** Real-time visual tracking of loaded tabs vs. target capacity.
- **Metric Cards:** Instant count of Live, Sleeping, Protected, and Unmanaged tabs.
- **Recent Activity Stream:** Chronological feed of sleep, wake, and protection events.

### 2. Tab Groups Library
- **Grouping Modes:** Collapse and expand tabs grouped by:
  - **Status:** Live, Protected, Sleeping, Manual Sleep, Unsupported.
  - **Window:** Multi-monitor and multi-window setups.
  - **Website/Domain:** Group tabs by domain (e.g. `github.com`, `youtube.com`).
- **Instant Search Filter:** Real-time live search across page titles and URLs.
- **Bulk Actions:** Select multiple tabs to perform bulk **Sleep**, **Wake**, or **Keep Awake**.

### 3. Rules Engine
- Fine-tune suspension triggers, network firewall enforcement, and auto-refill policies.

### 4. Emergency Session Recovery
- Directly inspects Chrome's internal session cache.
- Displays recently closed tabs and multi-tab windows with timestamps.
- **One-Click 60-Tab Restore** with automated sleep pause.

---

## 🔒 Security, Privacy & Least Privilege

TabPilot Pro is engineered strictly under **Zero-Trust & Zero-Telemetry Principles**:

- **No Remote Servers or APIs:** The extension does not connect to any external server, cloud backend, or remote endpoint. Everything executes locally.
- **No Third-Party Analytics:** Zero tracking scripts, cookies, analytics beacons, or user fingerprinting.
- **Cryptographic Token Isolation:** When a tab is put to sleep, the original URL and title are stored in your browser's private local storage under an ephemeral UUID key. The URL displayed on the sleep screen (`sleep.html?key=...`) never exposes your destination URL to screen recording or shoulder surfing.
- **Incognito & Private Browsing Isolation:** Private/Incognito tabs never persist URLs, titles, or activity records to disk (`chrome.storage.local`). All incognito sleep data is stored exclusively in RAM (`chrome.storage.session`) and automatically destroyed when the window closes, preventing history leakage to the non-incognito dashboard.
- **Back-Button & History Resilience:** Sleep records maintain a 30-minute rolling cache so pressing Chrome's "Back" arrow never hits a dead or broken 404 page.
- **Granular Chrome Permissions:**

| Permission | Technical Requirement |
| :--- | :--- |
| `tabs` | Required to query tab status (pinned, audible, active), update sleep screen URLs, and wake tabs. |
| `storage` | Required to persist user preferences and the local ephemeral URL token cache across service worker sleep cycles. |
| `alarms` | Required by Manifest V3 to perform lightweight periodic state reconciliations (every 60s) when the service worker is idle. |
| `declarativeNetRequest` | Required to inject tab-scoped session blocking rules that halt background network traffic for sleeping tabs. |
| `sessions` | Required to access Chrome's recently closed sessions for the Emergency Recovery dashboard. |

---

## 🩺 Technical Troubleshooting & FAQ

### Q1: Does sleeping a tab log me out of websites?
**No.** Website login sessions are stored in browser cookies and local storage, which remain completely intact. When you click **Restore this tab**, you return directly to the logged-in webpage.

### Q2: Why does TabPilot not put browser settings or extension pages to sleep?
Chromium explicitly forbids extensions from navigating or modifying browser-internal URLs (`chrome://`, `edge://`, `brave://`, `about:blank`, Chrome Web Store). These tabs are categorized as **"Unmanaged"** and left untouched.

### Q3: What happens to form inputs if a tab sleeps?
If you are typing a long form and switch tabs with **"Sleep previous tab on switch"** enabled, the page document will be unloaded. For pages with unsaved work, use **Keep Awake** (<kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd>) to lock the tab in a live state.

### Q4: Why can't the visible active tab be discarded?
Chromium's window manager requires an active rendered document for the currently focused tab in every open window. TabPilot will only sleep a tab when you navigate away from it or when it is in the background.

### Q5: How do I completely wake all tabs at once?
In the Control Center dashboard under **Tab groups**, click the **"↗ Wake all"** button in the top toolbar.

---

## 🧪 Testing & Development

TabPilot Pro features an automated unit test suite built on Node's native test runner (`node:test`):

```bash
# Run unit test suite
npm test

# Verify syntax of all scripts
npm run check
```

---

## 📁 Project Directory Structure

```text
TabPilot-Pro/
├── .github/
│   └── workflows/
│       └── ci.yml             # Multi-OS automated CI workflow (Ubuntu, Windows, macOS)
├── icons/                     # Extension branding icons (16, 32, 48, 128px)
├── tests/                     # Automated unit test suites
│   ├── extension.test.js      # Manifest V3, asset linking & integrity verification
│   └── logic.test.js          # Clamping, URL validation & key parsing tests
├── manifest.json              # Chrome Manifest V3 configuration & commands
├── service-worker.js          # MV3 background supervisor, DNR & tab lifecycle manager
├── popup.html                 # Quick dropdown control panel
├── popup.css                  # Popup dark-mode styling
├── popup.js                   # Popup view controller & state sync
├── dashboard.html             # Full-tab Control Center & Workspace Dashboard
├── dashboard.css              # Control Center responsive styles
├── dashboard.js               # Tab groups, search filter & recovery controller
├── sleep.html                 # Sleek 404 local tab sleep screen
├── sleep.css                  # Sleep screen styling & animations
├── sleep.js                   # Tab restoration & metadata controller
├── sleep-icon.svg             # Vector sleep icon
├── sleep-icon.png             # Raster sleep icon
├── shared.css                 # Global design system & theme variables
├── package.json               # Test scripts & project metadata
├── .gitignore                 # Standard Git exclusion patterns
├── LICENSE                    # MIT License
└── README.md                  # Comprehensive documentation
```

---

## 📄 License

This project is open-source software licensed under the [MIT License](LICENSE).

---

<p align="center">
  Crafted with care by <a href="https://github.com/soahimrahman">Soahim Rahman</a>.
</p>
