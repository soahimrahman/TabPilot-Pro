const $ = id => document.getElementById(id);
let state = null;
let currentView = "overview";
let selectedIds = new Set();
let toastTimer = null;

const copy = {
  overview: ["OVERVIEW", "Your browser, under control.", "Control live tabs, sleeping pages and browser activity."],
  tabs: ["TAB GROUPS", "Your tabs, organized.", "Group by status, window or website. Expand and collapse each group."],
  rules: ["SLEEP RULES", "Control what sleeps and what stays awake.", "Configure suspension, network blocking and automatic replacement."],
  activity: ["ACTIVITY LOG", "See what TabPilot has been doing.", "Review recent sleep, wake and skipped actions."],
  recovery: ["RECOVERY", "Bring your tabs back.", "Restore recently closed tabs and windows from Chrome session history."]
};

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (response?.ok === false) throw new Error(response.error || "Request failed.");
  return response;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function ago(ts) {
  if (!ts) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "Just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
function toast(message, error = false) {
  const el = $("toast");
  el.textContent = message;
  el.style.borderColor = error ? "#8c4b5a" : "#42658f";
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}
function setView(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${view}`));
  document.querySelectorAll(".nav-link").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  const c = copy[view] || copy.overview;
  $("crumb").textContent = c[0];
  $("pageTitle").textContent = c[1];
  $("pageSubtitle").textContent = c[2];
  if (view === "tabs") renderGroups();
  if (view === "activity") renderActivity();
  if (view === "recovery") refreshRecovery();
}
function stateOf(tab) {
  if (!tab.manageable) return ["Unsupported","unsupported"];
  if (tab.discarded && tab.manualSleep) return ["Manual sleep","manual-sleep"];
  if (tab.discarded) return ["Sleeping","sleeping"];
  if (tab.keepAwake || tab.pinned || tab.status === "protected") return ["Protected","protected"];
  return ["Live","live"];
}
function renderMetrics() {
  if (!state) return;
  const { counts, settings:s } = state;
  $("liveCount").textContent = counts.live;
  $("sleepCount").textContent = counts.sleeping;
  $("protectedCount").textContent = counts.protected;
  $("unsupportedCount").textContent = counts.unsupported;
  $("liveSub").textContent = `${counts.live} / ${s.maxLiveTabs} target · loaded pages`;
  $("liveBar").style.width = `${Math.min(100, counts.live / Math.max(1,s.maxLiveTabs) * 100)}%`;
  $("limitValue").textContent = s.maxLiveTabs;
  $("limitSlider").value = s.maxLiveTabs;
  $("sleepEnabled").checked = s.sleepModeEnabled;
  $("switchSleepEnabled").checked = s.sleepPreviousTabOnSwitch;
  $("networkEnabled").checked = s.blockNetworkWhileSleeping;
  $("ruleSleep").checked = s.sleepModeEnabled;
  $("ruleSwitchSleep").checked = s.sleepPreviousTabOnSwitch;
  $("ruleNetwork").checked = s.blockNetworkWhileSleeping;
  $("ruleRefill").checked = s.autoRefillOnClose;
  $("rulePinned").checked = s.protectPinned;
  $("ruleAudio").checked = s.protectAudible;
  $("navCount").textContent = counts.total;
  $("managerBadge").classList.toggle("on", s.sleepModeEnabled);
  $("managerBadge").innerHTML = `<i></i> Sleep Mode ${s.sleepModeEnabled ? "on" : "off"}`;
  document.querySelectorAll("[data-limit]").forEach(b => b.classList.toggle("selected", Number(b.dataset.limit) === s.maxLiveTabs));
}
function activityHtml(item) {
  const map = {
    sleep:["◌","sleep","Tab put to sleep"],
    "manual-sleep":["◌","sleep","Manually put to sleep"],
    wake:["↗","wake","Tab woken"],
    skip:["!","skip","Action skipped"]
  }[item.type] || ["·","","Tab activity"];
  return `<div class="activity-item"><div class="activity-symbol ${map[1]}">${map[0]}</div><div class="activity-copy"><b>${esc(item.title || map[2])}</b><small>${map[2]}${item.detail ? ` · ${esc(item.detail)}` : ""}</small></div><time class="activity-time">${ago(item.time)}</time></div>`;
}
function renderActivity() {
  if (!state) return;
  const items = state.activity || [];
  $("recentActivity").innerHTML = items.slice(0,6).map(activityHtml).join("") || '<div class="empty-state">No activity yet. Your tab actions will appear here.</div>';
  $("fullActivity").innerHTML = items.map(activityHtml).join("") || '<div class="empty-state">No activity yet.</div>';
}

let recoveryState = null;
function renderRecovery() {
  if (!recoveryState) return;
  $("recoveryTabCount").textContent = recoveryState.availableTabs;
  $("recoveryEntryCount").textContent = recoveryState.availableEntries;
  $("recoveryNavCount").textContent = recoveryState.availableTabs;
  $("recoveryLimitNote").textContent = `Chrome limit: ${recoveryState.entryLimit} session entries`;
  const entries = recoveryState.entries || [];
  if (!entries.length) {
    $("recoveryList").innerHTML = '<div class="empty-state">Chrome has no recently closed tabs or windows available.</div>';
    return;
  }
  $("recoveryList").innerHTML = entries.map((entry, index) => {
    let domain = "Recently closed";
    try { domain = new URL(entry.url).hostname || domain; } catch (_) {}
    const kind = entry.kind === "window" ? `Closed window · ${entry.tabCount} tab${entry.tabCount === 1 ? "" : "s"}` : "Closed tab";
    const when = entry.lastModified ? ago(entry.lastModified * 1000) : "Recently";
    return `<div class="recovery-item">
      <div class="recovery-item-icon">${entry.kind === "window" ? "▣" : "▤"}</div>
      <div class="recovery-item-copy"><b title="${esc(entry.title)}">${esc(entry.title)}</b><small>${esc(kind)} · ${esc(domain)} · ${esc(when)}</small></div>
      <span class="recovery-item-count">${entry.tabCount} tab${entry.tabCount === 1 ? "" : "s"}</span>
    </div>`;
  }).join("");
}
async function refreshRecovery() {
  $("recoveryMessage").textContent = "Checking Chrome's recently closed sessions…";
  $("refreshRecoveryButton").disabled = true;
  try {
    const result = await send("GET_RECOVERY_STATE");
    recoveryState = result.recovery;
    renderRecovery();
    $("recoveryMessage").textContent = recoveryState.availableTabs
      ? `${recoveryState.availableTabs} tab(s) are available across ${recoveryState.availableEntries} recent session entr${recoveryState.availableEntries === 1 ? "y" : "ies"}.`
      : "No recently closed tabs are available in Chrome's session history.";
  } catch (error) {
    $("recoveryMessage").textContent = error.message;
    $("recoveryList").innerHTML = '<div class="empty-state">Could not read Chrome recovery history.</div>';
  } finally {
    $("refreshRecoveryButton").disabled = false;
  }
}
async function restoreLast60() {
  const button = $("restoreLast60Button");
  button.disabled = true;
  button.textContent = "Restoring tabs…";
  $("recoveryMessage").textContent = "Pausing automatic sleep and restoring Chrome sessions. Keep this dashboard open.";
  try {
    const response = await send("RESTORE_LAST_TABS");
    const result = response.result;
    await refresh();
    await refreshRecovery();
    const details = result.failedEntries ? ` ${result.failedEntries} session(s) could not be restored.` : "";
    $("recoveryMessage").textContent = `${result.message}${details} Sleep Mode is OFF and switch-away sleep is OFF.`;
    toast(result.message, result.restoredTabs === 0);
  } catch (error) {
    $("recoveryMessage").textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "↶ Restore last 60 tabs";
  }
}

function domainOf(tab) {
  try { return new URL(tab.url).hostname.replace(/^www\./,"") || "Other pages"; }
  catch (_) { return "Browser pages"; }
}
function groupKey(tab, mode) {
  if (mode === "window") return `Window ${tab.windowId}`;
  if (mode === "domain") return domainOf(tab);
  const [label] = stateOf(tab);
  return label;
}
function groupClass(name) {
  if (/sleep/i.test(name)) return "sleeping";
  if (/protect/i.test(name)) return "protected";
  if (/unsupported/i.test(name)) return "unsupported";
  return "";
}
function rowHtml(tab) {
  const [baseLabel, cls] = stateOf(tab);
  const label = tab.discarded && state.settings.blockNetworkWhileSleeping
    ? (tab.manualSleep ? "Manual sleep · offline" : "Asleep · offline")
    : baseLabel;
  const disabledSleep = !tab.manageable || (tab.active && !tab.discarded);
  const action = tab.discarded ? "wake" : "sleep";
  const actionText = tab.discarded ? "Wake + keep" : "Sleep";
  const protection = tab.keepAwake ? "Keep Awake" : tab.pinned ? "Pinned" : tab.audible ? "Audio" : "—";
  const favicon = tab.favIconUrl ? `<img src="${esc(tab.favIconUrl)}" alt="" data-favicon>` : "◫";
  return `<div class="tab-row">
    <div class="page-cell"><input class="row-check" type="checkbox" data-select="${tab.id}" ${selectedIds.has(tab.id) ? "checked" : ""}>
      <div class="favicon">${favicon}</div><div class="page-copy"><b title="${esc(tab.title)}">${esc(tab.title)}</b><small title="${esc(tab.url)}">${esc(tab.url || "Browser page")}</small></div>
    </div>
    <span class="window-copy">Window ${tab.windowId}</span>
    <span><i class="state-pill ${cls}">${label}</i></span>
    <label class="protect-cell"><input type="checkbox" data-keep="${tab.id}" ${tab.keepAwake ? "checked" : ""} ${!tab.manageable ? "disabled" : ""}> Keep Awake</label>
    <div class="row-actions">
      <button data-action="${action}" data-id="${tab.id}" ${disabledSleep ? "disabled" : ""}>${actionText}</button>
      <button data-action="open" data-id="${tab.id}">Open</button>
    </div>
  </div>`;
}
function renderGroups() {
  if (!state) return;
  const query = $("searchInput").value.trim().toLowerCase();
  const filter = $("filter").value;
  const mode = $("groupBy").value;

  const tabs = [...state.tabs].filter(tab => {
    const text = `${tab.title} ${tab.url}`.toLowerCase();
    const [label] = stateOf(tab);
    const matchesSearch = !query || text.includes(query);
    const matchesFilter = filter === "all" ||
      (filter === "live" && tab.manageable && !tab.discarded) ||
      (filter === "sleeping" && tab.manageable && tab.discarded) ||
      (filter === "protected" && (tab.keepAwake || tab.pinned || tab.status === "protected")) ||
      (filter === "unsupported" && !tab.manageable);
    return matchesSearch && matchesFilter;
  }).sort((a,b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.discarded !== b.discarded) return a.discarded ? 1 : -1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });

  $("showingCount").textContent = `Showing ${tabs.length} of ${state.tabs.length} tabs`;
  if (!tabs.length) {
    $("groupsContainer").innerHTML = '<div class="empty-state">No tabs match this search or filter.</div>';
    updateSelection();
    return;
  }

  const groups = new Map();
  for (const tab of tabs) {
    const key = groupKey(tab, mode);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }

  const entries = [...groups.entries()].sort((a,b) => {
    if (mode === "status") {
      const order = ["Live","Protected","Sleeping","Manual sleep","Unsupported"];
      return order.indexOf(a[0]) - order.indexOf(b[0]);
    }
    return a[0].localeCompare(b[0]);
  });

  $("groupsContainer").innerHTML = entries.map(([name, members], index) => {
    const live = members.filter(t => t.manageable && !t.discarded).length;
    const sleeping = members.filter(t => t.manageable && t.discarded).length;
    const ids = members.map(t => t.id);
    const canWake = members.some(t => t.manageable && t.discarded);
    const canSleep = members.some(t => t.manageable && !t.discarded && !t.active);
    const groupAction = canWake
      ? `<button class="group-action" data-group-action="wake" data-ids="${ids.join(",")}">Wake group</button>`
      : canSleep
        ? `<button class="group-action" data-group-action="sleep" data-ids="${ids.join(",")}">Sleep group</button>`
        : "";
    return `<details class="tab-group" ${index < 3 ? "open" : ""}>
      <summary class="group-summary"><span class="group-chevron">›</span><i class="group-dot ${groupClass(name)}"></i><b class="group-name">${esc(name)}</b><span class="group-count">${members.length} tabs</span><span class="group-meta">${live} live · ${sleeping} sleeping</span>${groupAction}</summary>
      <div class="group-body"><div class="group-table-head"><span>PAGE</span><span>WINDOW</span><span>STATE</span><span>PROTECTION</span><span>ACTIONS</span></div>${members.map(rowHtml).join("")}</div>
    </details>`;
  }).join("");

  $("groupsContainer").querySelectorAll("img[data-favicon]").forEach(img => img.addEventListener("error", () => img.style.display = "none"));
  $("groupsContainer").querySelectorAll("[data-select]").forEach(input => input.addEventListener("change", () => {
    const id = Number(input.dataset.select);
    if (input.checked) selectedIds.add(id); else selectedIds.delete(id);
    updateSelection();
  }));
  $("groupsContainer").querySelectorAll("[data-keep]").forEach(input => input.addEventListener("change", async () => {
    try {
      await send("SET_KEEP_AWAKE", { tabId:Number(input.dataset.keep), enabled:input.checked });
      toast(input.checked ? "Tab is now protected." : "Keep Awake removed.");
      await refresh();
    } catch (error) { toast(error.message, true); }
  }));
  $("groupsContainer").querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", async () => {
    const id = Number(button.dataset.id);
    button.disabled = true;
    try {
      const action = button.dataset.action;
      if (action === "open") await send("OPEN_TAB", { tabId:id });
      else if (action === "sleep") await send("SLEEP_TAB", { tabId:id });
      else await send("WAKE_TAB", { tabId:id });
      toast(action === "sleep" ? "Tab put to sleep — tab remains open." : action === "wake" ? "Tab woken and protected." : "Tab opened.");
      await refresh();
    } catch (error) { toast(error.message, true); await refresh(); }
  }));
  $("groupsContainer").querySelectorAll("[data-group-action]").forEach(button => button.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    const ids = button.dataset.ids.split(",").map(Number);
    try {
      await send("BULK_ACTION", { tabIds:ids, action:button.dataset.groupAction });
      toast(button.dataset.groupAction === "wake" ? "Group wake requested." : "Eligible group tabs put to sleep.");
      await refresh();
    } catch (error) { toast(error.message, true); }
  }));
  updateSelection();
  const allDetails = [...$("groupsContainer").querySelectorAll("details")];
  $("collapseButton").textContent = allDetails.length && allDetails.every(d => d.open)
    ? "Collapse all" : "Expand all";
}
function updateSelection() {
  $("selectedCount").textContent = selectedIds.size;
  $("selectionBar").classList.toggle("visible", selectedIds.size > 0);
}
async function refresh() {
  try {
    state = await send("GET_STATE");
    renderMetrics();
    renderActivity();
    if (currentView === "tabs") renderGroups();
  } catch (error) {
    toast("Could not read TabPilot status. Reload the extension.", true);
  }
}
async function saveSettings(payload, messageId) {
  try {
    await send("UPDATE_SETTINGS", payload);
    await refresh();
    if (messageId) $(messageId).textContent = "Saved. TabPilot is applying your settings.";
    toast("Settings saved.");
  } catch (error) {
    if (messageId) $(messageId).textContent = error.message;
    toast(error.message, true);
  }
}

document.querySelectorAll(".nav-link").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
document.querySelectorAll("[data-goto]").forEach(b => b.addEventListener("click", () => setView(b.dataset.goto)));
$("manageTabsButton").addEventListener("click", () => setView("tabs"));
$("refreshButton").addEventListener("click", refresh);
$("restoreLast60Button").addEventListener("click", restoreLast60);
$("refreshRecoveryButton").addEventListener("click", refreshRecovery);

$("limitSlider").addEventListener("input", () => {
  $("limitValue").textContent = $("limitSlider").value;
  document.querySelectorAll("[data-limit]").forEach(b => b.classList.toggle("selected", Number(b.dataset.limit) === Number($("limitSlider").value)));
});
document.querySelectorAll("[data-limit]").forEach(b => b.addEventListener("click", () => {
  $("limitSlider").value = b.dataset.limit;
  $("limitValue").textContent = b.dataset.limit;
  document.querySelectorAll("[data-limit]").forEach(x => x.classList.toggle("selected", x === b));
}));
$("applyButton").addEventListener("click", () => saveSettings({
  maxLiveTabs:Number($("limitSlider").value),
  sleepModeEnabled:$("sleepEnabled").checked,
  sleepPreviousTabOnSwitch:$("switchSleepEnabled").checked,
  blockNetworkWhileSleeping:$("networkEnabled").checked
}, "settingsMessage"));
$("saveRulesButton").addEventListener("click", () => saveSettings({
  sleepModeEnabled:$("ruleSleep").checked,
  sleepPreviousTabOnSwitch:$("ruleSwitchSleep").checked,
  blockNetworkWhileSleeping:$("ruleNetwork").checked,
  autoRefillOnClose:$("ruleRefill").checked,
  protectPinned:$("rulePinned").checked,
  protectAudible:$("ruleAudio").checked
}, "rulesMessage"));

$("searchInput").addEventListener("input", renderGroups);
$("filter").addEventListener("change", renderGroups);
$("groupBy").addEventListener("change", renderGroups);
$("clearSelection").addEventListener("click", () => { selectedIds.clear(); renderGroups(); });
document.querySelectorAll("[data-bulk]").forEach(b => b.addEventListener("click", async () => {
  if (!selectedIds.size) return;
  try {
    await send("BULK_ACTION", { tabIds:[...selectedIds], action:b.dataset.bulk });
    selectedIds.clear();
    await refresh();
    toast("Bulk action completed.");
  } catch (error) { toast(error.message, true); }
}));
$("collapseButton").addEventListener("click", () => {
  const details = [...$("groupsContainer").querySelectorAll("details")];
  const allOpen = details.length > 0 && details.every(d => d.open);
  const shouldOpen = !allOpen;
  details.forEach(d => d.open = shouldOpen);
  $("collapseButton").textContent = shouldOpen ? "Collapse all" : "Expand all";
});
$("wakeAllButton").addEventListener("click", async () => {
  $("wakeAllButton").disabled = true;
  $("wakeAllButton").textContent = "Waking…";
  try {
    const result = await send("WAKE_ALL");
    await refresh();
    toast(`${result.woken} sleeping tabs restored and protected.`);
  } catch (error) { toast(error.message, true); }
  $("wakeAllButton").disabled = false;
  $("wakeAllButton").textContent = "↗ Wake all";
});

const requestedView = location.hash.replace(/^#/, "");
if (copy[requestedView]) setView(requestedView);

let dashboardReleaseUrl = "https://github.com/soahimrahman/TabPilot-Pro/releases";

async function checkDashboardUpdate(force = false) {
  try {
    const res = await send("CHECK_FOR_UPDATES", { force });
    const u = res?.update;
    if (u?.hasUpdate) {
      dashboardReleaseUrl = u.releasesUrl || dashboardReleaseUrl;
      $("dashboardUpdateVersion").textContent = `v${u.latestVersion}`;
      $("dashboardUpdateBanner").style.display = "flex";
    } else {
      $("dashboardUpdateBanner").style.display = "none";
    }
  } catch (_) {
    $("dashboardUpdateBanner").style.display = "none";
  }
}

$("dashboardReloadBtn").addEventListener("click", async () => {
  $("dashboardReloadBtn").disabled = true;
  $("dashboardReloadBtn").textContent = "Reloading…";
  await send("RELOAD_EXTENSION");
  setTimeout(() => location.reload(), 300);
});

$("dashboardGetBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: dashboardReleaseUrl });
});

refresh();
checkDashboardUpdate(false);
setInterval(refresh, 4000);
