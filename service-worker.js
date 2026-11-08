// TabPilot Pro 3.2 — replace sleeping sites with a local extension sleep screen.
// The original URL/title are retained in the sleep-page URL and restored on activation.

const DEFAULTS = {
  sleepModeEnabled: false,
  maxLiveTabs: 5,
  sleepPreviousTabOnSwitch: true,
  autoRefillOnClose: true,
  protectPinned: true,
  protectAudible: true,
  blockNetworkWhileSleeping: true,
  keepAwakeIds: [],
  manualSleepIds: [],
  activityLog: []
};

const BLOCKED_RESOURCE_TYPES = [
  "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"
];

let debounceTimer = null;
let scheduledRefill = false;
let scheduledReason = "event";
let reconcilePromise = null;
let reconcileRequested = false;
let pendingRefill = false;
let dnrQueue = Promise.resolve();
let activationQueue = Promise.resolve();
const wakingTabs = new Set();
let sleepDataCache = {};
let sleepDataCachePromise = null;
let incognitoSleepData = {};
const recentAudibleTabs = new Map();
const AUDIBLE_COOLDOWN_MS = 90000; // 90-second protection window for calls, meetings & media pauses

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureSleepDataCache() {
  if (!sleepDataCachePromise) {
    sleepDataCachePromise = chrome.storage.local
      .get({ sleepingTabs: {} })
      .then(result => {
        sleepDataCache = result.sleepingTabs && typeof result.sleepingTabs === "object"
          ? result.sleepingTabs
          : {};
        return sleepDataCache;
      })
      .catch(error => {
        sleepDataCachePromise = null;
        throw error;
      });
  }
  return sleepDataCachePromise;
}

async function ensureIncognitoCache() {
  try {
    const res = await chrome.storage.session.get({ incognitoSleepingTabs: {} });
    incognitoSleepData = res.incognitoSleepingTabs && typeof res.incognitoSleepingTabs === "object"
      ? res.incognitoSleepingTabs
      : {};
  } catch (_) {
    if (!incognitoSleepData) incognitoSleepData = {};
  }
  return incognitoSleepData;
}

function sleepPageKeyFromUrl(value) {
  try {
    const current = new URL(value);
    const sleepPage = new URL(chrome.runtime.getURL("sleep.html"));
    // chrome-extension: is a non-special URL scheme; URL.origin can be
    // "null", so compare protocol + host + path explicitly.
    if (
      current.protocol !== sleepPage.protocol ||
      current.host !== sleepPage.host ||
      current.pathname !== sleepPage.pathname
    ) return null;
    return current.searchParams.get("key") || null;
  } catch (_) {
    return null;
  }
}

async function pruneSleepDataCache(tabs) {
  await ensureSleepDataCache();
  await ensureIncognitoCache();
  const liveKeys = new Set(tabs.map(tab => sleepPageKeyFromUrl(rawTabUrl(tab))).filter(Boolean));
  const now = Date.now();

  const next = {};
  let changed = false;
  for (const [key, value] of Object.entries(sleepDataCache)) {
    // Keep currently live sleeping tabs, or recently restored tabs (within 30 mins) for back-button resilience
    const isLive = liveKeys.has(key);
    const isRecentRestore = value.restoredAt && (now - value.restoredAt < 1800000);
    if (isLive || isRecentRestore) next[key] = value;
    else changed = true;
  }
  if (changed) {
    sleepDataCache = next;
    await chrome.storage.local.set({ sleepingTabs: sleepDataCache });
  }

  // Also prune incognito session cache
  const nextIncognito = {};
  let incognitoChanged = false;
  for (const [key, value] of Object.entries(incognitoSleepData)) {
    const isLive = liveKeys.has(key);
    const isRecentRestore = value.restoredAt && (now - value.restoredAt < 1800000);
    if (isLive || isRecentRestore) nextIncognito[key] = value;
    else incognitoChanged = true;
  }
  if (incognitoChanged) {
    incognitoSleepData = nextIncognito;
    try {
      await chrome.storage.session.set({ incognitoSleepingTabs: incognitoSleepData });
    } catch (_) {}
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}

function rawTabUrl(tab) {
  return tab?.url || tab?.pendingUrl || "";
}

function sleepPageData(tab) {
  const key = sleepPageKeyFromUrl(rawTabUrl(tab));
  if (!key) return null;
  if (tab?.incognito && incognitoSleepData[key]) {
    return incognitoSleepData[key];
  }
  return sleepDataCache[key] || incognitoSleepData[key] || null;
}

function isSleepPage(tab) {
  return !!sleepPageKeyFromUrl(rawTabUrl(tab));
}

function isSleeping(tab) {
  return !!tab?.discarded || isSleepPage(tab);
}

function tabUrl(tab) {
  if (isSleepPage(tab)) return sleepPageData(tab)?.url || "";
  return rawTabUrl(tab);
}

function tabTitle(tab) {
  if (isSleepPage(tab)) return sleepPageData(tab)?.title || tab?.title || "Sleeping tab";
  return tab?.title || tabUrl(tab) || "Untitled tab";
}

function isManageable(tab) {
  if (isSleepPage(tab)) return true;
  const value = tabUrl(tab);
  return /^https?:\/\//i.test(value) || /^file:\/\//i.test(value);
}

async function makeSleepPageUrl(tab) {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  const entry = {
    url: tabUrl(tab),
    title: tabTitle(tab).slice(0, 500),
    createdAt: Date.now(),
    incognito: !!tab.incognito
  };

  // Preserve incognito privacy: do not write incognito tab details to persistent storage
  if (tab.incognito) {
    await ensureIncognitoCache();
    incognitoSleepData = {
      ...incognitoSleepData,
      [token]: entry
    };
    try {
      await chrome.storage.session.set({ incognitoSleepingTabs: incognitoSleepData });
    } catch (_) {}
  } else {
    await ensureSleepDataCache();
    sleepDataCache = {
      ...sleepDataCache,
      [token]: entry
    };
    await chrome.storage.local.set({ sleepingTabs: sleepDataCache });
  }

  const page = new URL(chrome.runtime.getURL("sleep.html"));
  page.searchParams.set("key", token);
  return page.toString();
}

function ruleIdForTab(tabId) {
  return Math.max(1, Number(tabId) + 1);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return {
    sleepModeEnabled: stored.sleepModeEnabled === true,
    maxLiveTabs: clamp(stored.maxLiveTabs, 1, 100, 5),
    sleepPreviousTabOnSwitch: stored.sleepPreviousTabOnSwitch !== false,
    autoRefillOnClose: stored.autoRefillOnClose !== false,
    protectPinned: stored.protectPinned !== false,
    protectAudible: stored.protectAudible !== false,
    blockNetworkWhileSleeping: stored.blockNetworkWhileSleeping !== false,
    keepAwakeIds: Array.isArray(stored.keepAwakeIds) ? stored.keepAwakeIds.filter(Number.isInteger) : [],
    manualSleepIds: Array.isArray(stored.manualSleepIds) ? stored.manualSleepIds.filter(Number.isInteger) : []
  };
}

function queueDnr(operation) {
  const next = dnrQueue.then(operation, operation);
  dnrQueue = next.catch(() => {});
  return next;
}

async function setNetworkBlock(tabId, shouldBlock) {
  if (!chrome.declarativeNetRequest || !Number.isInteger(tabId) || tabId < 0) return false;
  const ruleId = ruleIdForTab(tabId);

  return queueDnr(async () => {
    try {
      if (shouldBlock) {
        // Chrome only supports condition.tabIds in session-scoped DNR rules.
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId],
          addRules: [{
            id: ruleId,
            priority: 1,
            action: { type: "block" },
            condition: {
              tabIds: [tabId],
              resourceTypes: BLOCKED_RESOURCE_TYPES
            }
          }]
        });
      } else {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId]
        });
      }
      return true;
    } catch (error) {
      console.warn("TabPilot network rule could not be updated:", error);
      return false;
    }
  });
}

async function syncNetworkBlock(tab, settings = null) {
  await ensureSleepDataCache();
  const prefs = settings || await getSettings();
  if (!prefs.blockNetworkWhileSleeping) {
    await setNetworkBlock(tab.id, false);
    return;
  }
  await setNetworkBlock(tab.id, isSleeping(tab) && isManageable(tab));
}

async function clearAllSleepNetworkRules() {
  if (!chrome.declarativeNetRequest) return;
  return queueDnr(async () => {
    try {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      const ids = rules
        .filter(rule => Array.isArray(rule.condition?.tabIds))
        .map(rule => rule.id);
      if (ids.length) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    } catch (error) {
      console.warn("TabPilot could not clear network rules:", error);
    }
  });
}

async function addActivity(type, tab, detail = "") {
  try {
    // Preserve Incognito Privacy: never write private browsing activity to disk
    if (tab?.incognito) return;

    const stored = await chrome.storage.local.get({ activityLog: [] });
    const rows = Array.isArray(stored.activityLog) ? stored.activityLog : [];
    rows.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      title: tab?.title || tabUrl(tab || {}) || "Tab",
      url: tabUrl(tab || {}),
      detail,
      time: Date.now()
    });
    await chrome.storage.local.set({ activityLog: rows.slice(0, 80) });
  } catch (error) {
    console.warn("TabPilot activity log:", error);
  }
}

async function cleanPreferences(tabs, settings) {
  const existing = new Set(tabs.map(tab => tab.id));
  const keepAwakeIds = settings.keepAwakeIds.filter(id => existing.has(id));
  const manualSleepIds = settings.manualSleepIds.filter(id => existing.has(id));
  if (
    keepAwakeIds.length !== settings.keepAwakeIds.length ||
    manualSleepIds.length !== settings.manualSleepIds.length
  ) {
    await chrome.storage.local.set({ keepAwakeIds, manualSleepIds });
  }
  return { ...settings, keepAwakeIds, manualSleepIds };
}

function isAudibleOrRecent(tab, settings) {
  if (!settings.protectAudible) return false;
  if (tab.audible) {
    recentAudibleTabs.set(tab.id, Date.now());
    return true;
  }
  const lastAudible = recentAudibleTabs.get(tab.id);
  // Protect media/calls for 90 seconds after audio pauses (silence in meeting, song transition)
  if (lastAudible && (Date.now() - lastAudible) < AUDIBLE_COOLDOWN_MS) {
    return true;
  }
  return false;
}

function isProtected(tab, settings, keepAwake, manualSleep) {
  if (manualSleep.has(tab.id)) return false;
  if (keepAwake.has(tab.id)) return true;
  if (settings.protectPinned && tab.pinned) return true;
  if (isAudibleOrRecent(tab, settings)) return true;
  if (tab.status === "loading") return true;
  return false;
}

function newestFirst(a, b) {
  return (b.lastAccessed || 0) - (a.lastAccessed || 0);
}

async function getTab(tabId) {
  await ensureSleepDataCache();
  try { return await chrome.tabs.get(tabId); }
  catch (_) { return null; }
}

async function putTabToSleep(tab, manual = false) {
  try {
    if (isSleepPage(tab)) return true;

    const original = {
      ...tab,
      title: tabTitle(tab),
      url: tabUrl(tab)
    };
    const sleepUrl = await makeSleepPageUrl(original);

    // Replacing the top-level document unloads the original site completely.
    // The original URL/title are carried in the local extension URL so the
    // same tab can restore itself when selected later.
    await setNetworkBlock(tab.id, false);
    await chrome.tabs.update(tab.id, { url: sleepUrl });

    const settings = await getSettings();
    if (settings.blockNetworkWhileSleeping) await setNetworkBlock(tab.id, true);
    await addActivity(manual ? "manual-sleep" : "sleep", original);
    return true;
  } catch (error) {
    await addActivity("skip", tab, error?.message || "Could not replace this tab with the sleep screen");
    return false;
  }
}

async function seedActiveTabMap() {
  try {
    const activeTabs = await chrome.tabs.query({ active: true });
    const stored = await chrome.storage.session.get({ activeTabByWindow: {} });
    const activeTabByWindow = { ...(stored.activeTabByWindow || {}) };
    for (const tab of activeTabs) {
      const key = String(tab.windowId);
      // Preserve a known previous active tab. This matters when MV3 wakes
      // the service worker because of the activation event itself.
      if (Number.isInteger(tab.windowId) && Number.isInteger(tab.id) &&
          !Number.isInteger(activeTabByWindow[key])) {
        activeTabByWindow[key] = tab.id;
      }
    }
    await chrome.storage.session.set({ activeTabByWindow });
  } catch (error) {
    console.warn("TabPilot could not initialize active-tab tracking:", error);
  }
}

async function sleepPreviousTab(previousTabId, newActiveTabId) {
  if (!Number.isInteger(previousTabId) || previousTabId < 0 || previousTabId === newActiveTabId) return;

  const settings = await getSettings();
  if (!settings.sleepModeEnabled || !settings.sleepPreviousTabOnSwitch) return;

  const keepAwake = new Set(settings.keepAwakeIds);
  const manualSleep = new Set(settings.manualSleepIds);
  let previous = await getTab(previousTabId);

  if (
    !previous ||
    previous.active ||
    isSleeping(previous) ||
    !isManageable(previous) ||
    manualSleep.has(previousTabId) ||
    keepAwake.has(previousTabId) ||
    (settings.protectPinned && previous.pinned) ||
    isAudibleOrRecent(previous, settings)
  ) return;

  // 4-second grace period: prevents rapid switch-back thrashing when comparing tabs or copying text
  await delay(4000);
  previous = await getTab(previousTabId);
  if (
    !previous ||
    previous.active ||
    isSleeping(previous) ||
    !isManageable(previous) ||
    previous.status === "loading"
  ) return;

  await putTabToSleep(previous, false);
}

async function handleTabActivation(info) {
  await ensureSleepDataCache();
  const tabId = info?.tabId;
  const windowId = info?.windowId;
  if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return;

  // The active-tab map is stored in storage.session so it survives MV3
  // service-worker suspension/restarts without persisting across browser restarts.
  const stored = await chrome.storage.session.get({ activeTabByWindow: {} });
  const activeTabByWindow = { ...(stored.activeTabByWindow || {}) };
  const previousTabId = Number(activeTabByWindow[String(windowId)]);
  activeTabByWindow[String(windowId)] = tabId;
  await chrome.storage.session.set({ activeTabByWindow });

  await setNetworkBlock(tabId, false);
  if (wakingTabs.has(tabId)) return;

  const settings = await getSettings();
  if (settings.manualSleepIds.includes(tabId)) {
    await chrome.storage.local.set({
      manualSleepIds: settings.manualSleepIds.filter(id => id !== tabId)
    });
  }

  // Deliberately leave a sleeping tab on the local 404 screen.
  // The original website is restored only when the user presses "Restore this tab".

  if (Number.isInteger(previousTabId) && previousTabId >= 0) {
    await sleepPreviousTab(previousTabId, tabId);
  }

  scheduleReconcile("tab-activated", false, 250);
}

// Restores custom sleep pages by navigating the same tab to its saved URL.
// A compatibility path remains for tabs natively discarded by older builds.
async function wakeTabInBackground(tabId) {
  if (wakingTabs.has(tabId)) {
    const current = await getTab(tabId);
    return !!current && !isSleepPage(current) && !current.discarded;
  }
  const target = await getTab(tabId);
  if (!target) return false;

  const sleepData = sleepPageData(target);
  if (sleepData) {
    wakingTabs.add(tabId);
    try {
      await setNetworkBlock(tabId, false);
      await chrome.tabs.update(tabId, { url: sleepData.url });

      let restored = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await delay(100);
        const current = await getTab(tabId);
        if (!current) break;
        if (!isSleepPage(current) && isManageable(current)) {
          restored = true;
          if (current.status === "complete") break;
        }
      }

      const finalTab = await getTab(tabId);
      if (restored && finalTab && !isSleepPage(finalTab)) {
        const key = sleepPageKeyFromUrl(rawTabUrl(target));
        if (key) {
          if (target.incognito && incognitoSleepData[key]) {
            incognitoSleepData = {
              ...incognitoSleepData,
              [key]: { ...incognitoSleepData[key], restoredAt: Date.now() }
            };
            try {
              await chrome.storage.session.set({ incognitoSleepingTabs: incognitoSleepData });
            } catch (_) {}
          } else if (sleepDataCache[key]) {
            sleepDataCache = {
              ...sleepDataCache,
              [key]: { ...sleepDataCache[key], restoredAt: Date.now() }
            };
            await chrome.storage.local.set({ sleepingTabs: sleepDataCache });
          }
        }
        await addActivity("wake", { ...finalTab, title: tabTitle(finalTab), url: tabUrl(finalTab) });
        return true;
      }
      await addActivity("skip", target, "The original page did not finish restoring in time");
      return false;
    } catch (error) {
      await addActivity("skip", target, error?.message || "Could not restore the original page");
      return false;
    } finally {
      wakingTabs.delete(tabId);
    }
  }

  // Compatibility with tabs that were natively discarded by an older build.
  if (!target.discarded) {
    await setNetworkBlock(tabId, false);
    return true;
  }

  wakingTabs.add(tabId);
  try {
    await setNetworkBlock(tabId, false);
    const siblings = await chrome.tabs.query({ windowId: target.windowId });
    const previousActive = siblings.find(tab => tab.active && tab.id !== tabId);
    await chrome.tabs.update(tabId, { active: true });

    let restored = false;
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await delay(100);
      const current = await getTab(tabId);
      if (!current) break;
      if (!current.discarded) { restored = true; break; }
    }

    if (previousActive) {
      const previousStillExists = await getTab(previousActive.id);
      if (previousStillExists) await chrome.tabs.update(previousActive.id, { active: true });
    }

    const finalTab = await getTab(tabId);
    if (restored && finalTab && !finalTab.discarded) {
      await addActivity("wake", finalTab);
      return true;
    }
    await addActivity("skip", target, "Chrome did not restore the tab in time");
    return false;
  } catch (error) {
    await addActivity("skip", target, error?.message || "Could not wake tab");
    return false;
  } finally {
    wakingTabs.delete(tabId);
  }
}

async function refillFreeSlots(settings) {
  if (!settings.autoRefillOnClose) return;
  await ensureSleepDataCache();

  const tabs = await chrome.tabs.query({});
  const managed = tabs.filter(isManageable);
  const liveCount = managed.filter(tab => !isSleeping(tab)).length;
  let freeSlots = Math.max(0, settings.maxLiveTabs - liveCount);
  if (!freeSlots) return;

  const keepAwake = new Set(settings.keepAwakeIds);
  const manualSleep = new Set(settings.manualSleepIds);

  const candidates = managed
    .filter(tab =>
      isSleeping(tab) &&
      !manualSleep.has(tab.id) &&
      !keepAwake.has(tab.id) &&
      !(settings.protectPinned && tab.pinned) &&
      !(settings.protectAudible && tab.audible)
    )
    .sort(newestFirst);

  for (const tab of candidates) {
    if (freeSlots <= 0) break;
    const woke = await wakeTabInBackground(tab.id);
    if (woke) freeSlots -= 1;
  }
}

async function reconcileOnce(refill, reason) {
  await ensureSleepDataCache();
  let settings = await getSettings();
  const allTabs = await chrome.tabs.query({});
  await pruneSleepDataCache(allTabs);
  settings = await cleanPreferences(allTabs, settings);

  // Keep network blocks in sync even when auto sleep is paused.
  if (settings.blockNetworkWhileSleeping) {
    for (const tab of allTabs) {
      if (isManageable(tab) && isSleeping(tab)) await setNetworkBlock(tab.id, true);
    }
  }

  if (!settings.sleepModeEnabled) {
    if (refill) await refillFreeSlots(settings);
    return;
  }

  const managed = allTabs.filter(isManageable);
  const keepAwake = new Set(settings.keepAwakeIds);
  const manualSleep = new Set(settings.manualSleepIds);

  // Migrate legacy Chrome-discarded tabs from v3.1 into the visible TabPilot
  // sleep screen, so every sleeping tab gets the same grey icon and 404 page.
  for (const tab of managed) {
    if (tab.discarded && !isSleepPage(tab) && !tab.active) {
      await putTabToSleep(tab, manualSleep.has(tab.id));
    }
  }

  const refreshedTabs = await chrome.tabs.query({});
  const refreshedManaged = refreshedTabs.filter(isManageable);
  const live = refreshedManaged.filter(tab => !isSleeping(tab));

  const fixedLive = live.filter(tab =>
    !manualSleep.has(tab.id) &&
    (tab.active || isProtected(tab, settings, keepAwake, manualSleep))
  );

  const ordinaryLive = live
    .filter(tab => !fixedLive.some(item => item.id === tab.id) && !manualSleep.has(tab.id))
    .sort(newestFirst);

  const ordinarySlots = Math.max(0, settings.maxLiveTabs - fixedLive.length);
  const keepIds = new Set([
    ...fixedLive.map(tab => tab.id),
    ...ordinaryLive.slice(0, ordinarySlots).map(tab => tab.id)
  ]);

  const toSleep = live.filter(tab => !keepIds.has(tab.id));
  for (const tab of toSleep) {
    if (!tab.active) await putTabToSleep(tab, manualSleep.has(tab.id));
  }

  if (refill) {
    const latest = await getSettings();
    await refillFreeSlots(latest);
  }
}

async function runReconcile(refill = false, reason = "event") {
  if (reconcilePromise) {
    reconcileRequested = true;
    pendingRefill = pendingRefill || refill;
    return reconcilePromise;
  }

  reconcilePromise = (async () => {
    let shouldRefill = refill;
    let currentReason = reason;
    do {
      reconcileRequested = false;
      pendingRefill = false;
      try {
        await reconcileOnce(shouldRefill, currentReason);
      } catch (error) {
        console.error("TabPilot reconcile failed:", error);
      }
      shouldRefill = pendingRefill;
      currentReason = "queued-event";
    } while (reconcileRequested);
  })();

  try { await reconcilePromise; }
  finally { reconcilePromise = null; }
}

function scheduleReconcile(reason = "event", refill = false, wait = 350) {
  // Preserve a close/refill event if more ordinary tab events arrive in the
  // same debounce window.
  if (refill) {
    scheduledRefill = true;
    scheduledReason = reason;
  } else if (!scheduledRefill) {
    scheduledReason = reason;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const doRefill = scheduledRefill;
    const why = scheduledReason;
    scheduledRefill = false;
    scheduledReason = "event";
    runReconcile(doRefill, why);
  }, wait);
}

async function setKeepAwake(tabId, enabled) {
  const settings = await getSettings();
  const keepAwakeIds = settings.keepAwakeIds.filter(id => id !== tabId);
  const manualSleepIds = settings.manualSleepIds.filter(id => id !== tabId);
  if (enabled) keepAwakeIds.push(tabId);
  await chrome.storage.local.set({ keepAwakeIds, manualSleepIds });

  const tab = await getTab(tabId);
  if (enabled && tab && isSleeping(tab)) await wakeTabInBackground(tabId);
  scheduleReconcile("keep-awake-change", false, 100);
}

async function sleepTab(tabId) {
  const tab = await getTab(tabId);
  if (!tab) throw new Error("This tab no longer exists.");
  if (!isManageable(tab)) throw new Error("Browser-internal pages cannot be put to sleep.");
  if (tab.active) throw new Error("Switch to another tab before putting this tab to sleep.");

  const settings = await getSettings();
  await chrome.storage.local.set({
    manualSleepIds: [...new Set([...settings.manualSleepIds, tabId])],
    keepAwakeIds: settings.keepAwakeIds.filter(id => id !== tabId)
  });

  if (!isSleepPage(tab)) {
    const slept = await putTabToSleep(tab, true);
    if (!slept) throw new Error("TabPilot could not replace this page with the sleep screen.");
  } else {
    await syncNetworkBlock(tab, settings);
  }
  scheduleReconcile("manual-sleep", false, 100);
}

async function wakeTab(tabId) {
  const settings = await getSettings();
  await chrome.storage.local.set({
    manualSleepIds: settings.manualSleepIds.filter(id => id !== tabId),
    keepAwakeIds: [...new Set([...settings.keepAwakeIds, tabId])]
  });

  const success = await wakeTabInBackground(tabId);
  if (!success) throw new Error("TabPilot could not restore this tab. Try selecting it in the tab bar.");
  scheduleReconcile("manual-wake", false, 500);
}

// Restores a sleeping tab without forcing it into the permanent keepAwake whitelist.
async function restoreSleepTab(tabId) {
  const settings = await getSettings();
  if (settings.manualSleepIds.includes(tabId)) {
    await chrome.storage.local.set({
      manualSleepIds: settings.manualSleepIds.filter(id => id !== tabId)
    });
  }

  const success = await wakeTabInBackground(tabId);
  if (!success) throw new Error("TabPilot could not restore this tab. Try selecting it in the tab bar.");
  scheduleReconcile("sleep-screen-restore", false, 500);
}

async function closeTab(tabId) {
  // Safety behavior: TabPilot never closes tabs. Legacy CLOSE_TAB requests
  // are converted into sleep requests so the tab remains in the tab strip.
  await sleepTab(tabId);
}

async function bulkAction(tabIds, action) {
  const ids = [...new Set((Array.isArray(tabIds) ? tabIds : []).map(Number).filter(Number.isInteger))];
  const settings = await getSettings();

  if (action === "keep") {
    await chrome.storage.local.set({
      keepAwakeIds: [...new Set([...settings.keepAwakeIds, ...ids])],
      manualSleepIds: settings.manualSleepIds.filter(id => !ids.includes(id))
    });
    for (const id of ids) {
      const tab = await getTab(id);
      if (tab && isSleeping(tab)) await wakeTabInBackground(id);
    }
  } else if (action === "sleep") {
    const eligible = [];
    for (const id of ids) {
      const tab = await getTab(id);
      if (tab && isManageable(tab) && !tab.active) eligible.push(tab);
    }
    await chrome.storage.local.set({
      manualSleepIds: [...new Set([...settings.manualSleepIds, ...eligible.map(tab => tab.id)])],
      keepAwakeIds: settings.keepAwakeIds.filter(id => !eligible.some(tab => tab.id === id))
    });
    for (const tab of eligible) {
      if (!isSleepPage(tab)) await putTabToSleep(tab, true);
    }
  } else if (action === "wake") {
    for (const id of ids) {
      const tab = await getTab(id);
      if (!tab || !isSleeping(tab)) continue;
      const current = await getSettings();
      if (current.manualSleepIds.includes(id)) {
        await chrome.storage.local.set({
          manualSleepIds: current.manualSleepIds.filter(value => value !== id)
        });
      }
      await wakeTabInBackground(id);
    }
  } else if (action === "unprotect") {
    await chrome.storage.local.set({
      keepAwakeIds: settings.keepAwakeIds.filter(id => !ids.includes(id))
    });
  } else if (action === "close") {
    // Backward compatibility only: old "close" requests now sleep tabs.
    const eligible = [];
    for (const id of ids) {
      const tab = await getTab(id);
      if (tab && isManageable(tab) && !tab.active) eligible.push(tab);
    }
    await chrome.storage.local.set({
      manualSleepIds: [...new Set([...settings.manualSleepIds, ...eligible.map(tab => tab.id)])],
      keepAwakeIds: settings.keepAwakeIds.filter(id => !eligible.some(tab => tab.id === id))
    });
    for (const tab of eligible) {
      if (!isSleepPage(tab)) await putTabToSleep(tab, true);
    }
  } else {
    throw new Error("Unknown bulk action.");
  }

  scheduleReconcile("bulk-action", false, 150);
}

async function updateSettings(message) {
  await ensureSleepDataCache();
  const current = await getSettings();
  const next = {
    sleepModeEnabled: message.sleepModeEnabled === undefined ? current.sleepModeEnabled : !!message.sleepModeEnabled,
    maxLiveTabs: message.maxLiveTabs === undefined ? current.maxLiveTabs : clamp(message.maxLiveTabs, 1, 100, current.maxLiveTabs),
    sleepPreviousTabOnSwitch: message.sleepPreviousTabOnSwitch === undefined ? current.sleepPreviousTabOnSwitch : !!message.sleepPreviousTabOnSwitch,
    autoRefillOnClose: message.autoRefillOnClose === undefined ? current.autoRefillOnClose : !!message.autoRefillOnClose,
    protectPinned: message.protectPinned === undefined ? current.protectPinned : !!message.protectPinned,
    protectAudible: message.protectAudible === undefined ? current.protectAudible : !!message.protectAudible,
    blockNetworkWhileSleeping: message.blockNetworkWhileSleeping === undefined ? current.blockNetworkWhileSleeping : !!message.blockNetworkWhileSleeping
  };
  await chrome.storage.local.set(next);

  if (!next.blockNetworkWhileSleeping) {
    await clearAllSleepNetworkRules();
  } else {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (isSleeping(tab) && isManageable(tab)) await setNetworkBlock(tab.id, true);
    }
  }

  scheduleReconcile("settings-change", next.sleepModeEnabled, 150);
  return next;
}

async function getState() {
  await ensureSleepDataCache();
  const settings = await getSettings();
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.local.get({ activityLog: [] })
  ]);
  const keepAwake = new Set(settings.keepAwakeIds);
  const manualSleep = new Set(settings.manualSleepIds);

  const rows = tabs.map(tab => {
    const manageable = isManageable(tab);
    const sleeping = isSleeping(tab);
    let status = "live";
    if (!manageable) status = "unsupported";
    else if (sleeping && manualSleep.has(tab.id)) status = "manual-sleep";
    else if (sleeping) status = "sleeping";
    else if (!manualSleep.has(tab.id) &&
      (keepAwake.has(tab.id) ||
       (settings.protectPinned && tab.pinned) ||
       (settings.protectAudible && tab.audible))) status = "protected";

    return {
      id: tab.id,
      windowId: tab.windowId,
      title: tabTitle(tab),
      url: tabUrl(tab),
      favIconUrl: tab.favIconUrl || "",
      active: !!tab.active,
      pinned: !!tab.pinned,
      audible: !!tab.audible,
      discarded: sleeping,
      sleepPage: isSleepPage(tab),
      manageable,
      keepAwake: keepAwake.has(tab.id),
      manualSleep: manualSleep.has(tab.id),
      status,
      lastAccessed: tab.lastAccessed || 0
    };
  });

  const managed = rows.filter(tab => tab.manageable);
  const live = managed.filter(tab => !isSleeping(tab));
  const sleeping = managed.filter(tab => isSleeping(tab));

  return {
    settings,
    tabs: rows,
    activity: Array.isArray(stored.activityLog) ? stored.activityLog.slice(0, 40) : [],
    counts: {
      total: rows.length,
      managed: managed.length,
      live: live.length,
      sleeping: sleeping.length,
      protected: live.filter(tab => tab.status === "protected" || tab.pinned || tab.active).length,
      unsupported: rows.filter(tab => !tab.manageable).length,
      active: live.filter(tab => tab.active).length
    }
  };
}

async function wakeAllSleeping() {
  await ensureSleepDataCache();
  await ensureIncognitoCache();
  const tabs = await chrome.tabs.query({});
  const candidates = tabs
    .filter(tab => isManageable(tab) && isSleeping(tab))
    .sort(newestFirst);
  let woken = 0;
  for (const tab of candidates) {
    const current = await getSettings();
    if (current.manualSleepIds.includes(tab.id)) {
      await chrome.storage.local.set({
        manualSleepIds: current.manualSleepIds.filter(id => id !== tab.id)
      });
    }
    if (await wakeTabInBackground(tab.id)) woken += 1;
  }
  return woken;
}


async function getRecoveryState() {
  if (!chrome.sessions?.getRecentlyClosed) {
    throw new Error("Chrome session recovery is not available in this browser.");
  }

  const maxEntries = Number(chrome.sessions.MAX_SESSION_RESULTS) || 25;
  const recent = await chrome.sessions.getRecentlyClosed({ maxResults: maxEntries });
  const entries = recent.map((entry, index) => {
    if (entry.tab) {
      return {
        key: `tab-${index}`,
        kind: "tab",
        sessionId: entry.tab.sessionId || "",
        title: entry.tab.title || entry.tab.url || "Recently closed tab",
        url: entry.tab.url || "",
        tabCount: 1,
        lastModified: entry.lastModified || 0
      };
    }

    const tabs = Array.isArray(entry.window?.tabs) ? entry.window.tabs : [];
    const firstTab = tabs[0] || {};
    return {
      key: `window-${index}`,
      kind: "window",
      sessionId: entry.window?.sessionId || "",
      title: entry.window?.title || firstTab.title || "Recently closed window",
      url: firstTab.url || "",
      tabCount: tabs.length,
      lastModified: entry.lastModified || 0
    };
  });

  return {
    entries,
    entryLimit: maxEntries,
    availableEntries: entries.length,
    availableTabs: entries.reduce((sum, entry) => sum + entry.tabCount, 0)
  };
}

async function restoreRecentTabs(targetCount = 60) {
  if (!chrome.sessions?.getRecentlyClosed || !chrome.sessions?.restore) {
    throw new Error("Chrome session recovery is not available in this browser.");
  }

  const limit = Math.max(1, Math.min(60, Number(targetCount) || 60));
  const maxEntries = Number(chrome.sessions.MAX_SESSION_RESULTS) || 25;
  const recent = await chrome.sessions.getRecentlyClosed({ maxResults: maxEntries });

  if (!recent.length) {
    return { restoredTabs: 0, restoredEntries: 0, failedEntries: 0, message: "Chrome has no recently closed tabs or windows available." };
  }

  // Pause automatic sleeping before recovery. Otherwise restored tabs could
  // immediately be sent back to sleep while Chrome is rebuilding the session.
  const currentSettings = await getSettings();
  await chrome.storage.local.set({
    sleepModeEnabled: false,
    sleepPreviousTabOnSwitch: false
  });

  let restoredTabs = 0;
  let restoredEntries = 0;
  let failedEntries = 0;
  let restoredWholeWindows = 0;

  for (const entry of recent) {
    if (restoredTabs >= limit) break;

    try {
      if (entry.tab) {
        if (!entry.tab.sessionId) {
          failedEntries += 1;
          continue;
        }
        await chrome.sessions.restore(entry.tab.sessionId);
        restoredTabs += 1;
        restoredEntries += 1;
        continue;
      }

      if (entry.window) {
        const windowTabs = Array.isArray(entry.window.tabs) ? entry.window.tabs : [];
        const count = windowTabs.length;
        if (!entry.window.sessionId && !windowTabs.some(tab => tab.sessionId)) {
          failedEntries += 1;
          continue;
        }

        const remaining = limit - restoredTabs;

        // Restore a whole closed window when it fits within the requested
        // recovery target. This preserves its original window/tab structure.
        if (count <= remaining && entry.window.sessionId) {
          await chrome.sessions.restore(entry.window.sessionId);
          restoredTabs += count;
          restoredEntries += 1;
          restoredWholeWindows += 1;
          continue;
        }

        // If a closed window is larger than the remaining target, restore
        // individual tab sessions where Chrome exposes their session IDs.
        const restorableTabs = windowTabs.filter(tab => tab.sessionId);
        if (restorableTabs.length) {
          let restoredFromWindow = 0;
          for (const tab of restorableTabs) {
            if (restoredTabs >= limit) break;
            try {
              await chrome.sessions.restore(tab.sessionId);
              restoredTabs += 1;
              restoredFromWindow += 1;
            } catch (error) {
              // A tab-level session can be unavailable after Chrome prunes
              // or merges a window restore record. Stop this window safely.
              break;
            }
          }
          if (restoredFromWindow > 0) {
            restoredEntries += 1;
            continue;
          }
        }

        // Fallback: Chrome may only expose the closed window as one session.
        // Restoring it can bring back more than the requested remaining count.
        if (entry.window.sessionId) {
          await chrome.sessions.restore(entry.window.sessionId);
          restoredTabs += count;
          restoredEntries += 1;
          restoredWholeWindows += 1;
        } else {
          failedEntries += 1;
        }
      }
    } catch (error) {
      failedEntries += 1;
    }
  }

  // Keep Sleep Mode and switch-away sleeping disabled after recovery. The user
  // can turn them back on after confirming the restored workspace is intact.
  const message = restoredTabs
    ? `Restored ${restoredTabs} tab(s). Automatic sleeping is paused so they stay open.`
    : "No tabs could be restored from Chrome's recent session history.";

  return {
    restoredTabs,
    restoredEntries,
    failedEntries,
    restoredWholeWindows,
    message,
    sleepModePaused: true,
    availableEntries: recent.length,
    entryLimit: maxEntries
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(null);
  const initial = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (stored[key] === undefined) initial[key] = value;
  }
  if (Object.keys(initial).length) await chrome.storage.local.set(initial);
  chrome.alarms.create("tabpilot-reconcile", { periodInMinutes: 1 });
  await ensureSleepDataCache();
  await seedActiveTabMap();
  scheduleReconcile("install", false, 1000);
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create("tabpilot-reconcile", { periodInMinutes: 1 });
  await ensureSleepDataCache();
  await seedActiveTabMap();
  const currentTabs = await chrome.tabs.query({});
  const settings = await getSettings();
  for (const tab of currentTabs) {
    if (isSleeping(tab) && isManageable(tab)) await syncNetworkBlock(tab, settings);
  }
  scheduleReconcile("startup", false, 1200);
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "tabpilot-reconcile") scheduleReconcile("periodic-check", false, 100);
});

chrome.tabs.onCreated.addListener(() => scheduleReconcile("tab-created", false, 400));

chrome.tabs.onRemoved.addListener((tabId) => {
  recentAudibleTabs.delete(tabId);
  setNetworkBlock(tabId, false);
  chrome.storage.session.get({ activeTabByWindow: {} }).then(stored => {
    const activeTabByWindow = { ...(stored.activeTabByWindow || {}) };
    for (const [windowId, activeId] of Object.entries(activeTabByWindow)) {
      if (activeId === tabId) delete activeTabByWindow[windowId];
    }
    return chrome.storage.session.set({ activeTabByWindow });
  }).catch(() => {});
  getSettings().then(settings => {
    chrome.storage.local.set({
      keepAwakeIds: settings.keepAwakeIds.filter(id => id !== tabId),
      manualSleepIds: settings.manualSleepIds.filter(id => id !== tabId)
    });
    scheduleReconcile("tab-closed", settings.autoRefillOnClose, 900);
  });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  setNetworkBlock(removedTabId, false);
  getSettings().then(settings => {
    chrome.storage.local.set({
      keepAwakeIds: settings.keepAwakeIds.filter(id => id !== removedTabId),
      manualSleepIds: settings.manualSleepIds.filter(id => id !== removedTabId)
    });
    getTab(addedTabId).then(tab => {
      if (tab && isSleeping(tab)) syncNetworkBlock(tab, settings);
    });
    scheduleReconcile("tab-replaced", false, 400);
  });
});

chrome.tabs.onActivated.addListener(info => {
  activationQueue = activationQueue
    .then(() => handleTabActivation(info))
    .catch(error => console.warn("TabPilot activation handler failed:", error));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.audible === true) {
    recentAudibleTabs.set(tabId, Date.now());
  }

  if (changeInfo.discarded === true) {
    syncNetworkBlock(tab, null);
  } else if (changeInfo.discarded === false) {
    setNetworkBlock(tabId, false);
  }

  if (wakingTabs.has(tabId)) return;
  if (
    changeInfo.status === "complete" ||
    changeInfo.discarded !== undefined ||
    changeInfo.pinned !== undefined ||
    changeInfo.audible !== undefined ||
    changeInfo.url !== undefined
  ) {
    scheduleReconcile("tab-updated", false, 700);
  }
});

chrome.windows.onFocusChanged.addListener(() => scheduleReconcile("window-focus", false, 500));

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.sleepingTabs) {
    sleepDataCache = changes.sleepingTabs.newValue && typeof changes.sleepingTabs.newValue === "object"
      ? changes.sleepingTabs.newValue
      : {};
    sleepDataCachePromise = Promise.resolve(sleepDataCache);
  }
  const policyKeys = [
    "sleepModeEnabled", "maxLiveTabs", "sleepPreviousTabOnSwitch",
    "autoRefillOnClose", "protectPinned", "protectAudible", "blockNetworkWhileSleeping"
  ];
  if (policyKeys.some(key => changes[key])) {
    scheduleReconcile("settings-change", true, 200);
  } else if (changes.keepAwakeIds || changes.manualSleepIds) {
    scheduleReconcile("tab-preference-change", false, 200);
  }
});

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    try {
      if (command === "open-dashboard") {
        chrome.runtime.openOptionsPage();
      } else if (command === "toggle-keep-awake") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && isManageable(tab)) {
          const settings = await getSettings();
          const enabled = !settings.keepAwakeIds.includes(tab.id);
          await setKeepAwake(tab.id, enabled);
        }
      } else if (command === "sleep-other-tabs") {
        const currentTabs = await chrome.tabs.query({ currentWindow: true });
        const targetIds = currentTabs
          .filter(t => !t.active && isManageable(t) && !isSleeping(t))
          .map(t => t.id);
        if (targetIds.length) {
          await bulkAction(targetIds, "sleep");
        }
      }
    } catch (error) {
      console.warn("TabPilot command handler:", error);
    }
  });
}

seedActiveTabMap();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_STATE":
        return await getState();

      case "GET_RECOVERY_STATE":
        return { ok: true, recovery: await getRecoveryState() };

      case "RESTORE_LAST_TABS":
        return { ok: true, result: await restoreRecentTabs(60) };

      case "UPDATE_SETTINGS":
        await updateSettings(message);
        return { ok: true, state: await getState() };

      case "SET_KEEP_AWAKE":
        await setKeepAwake(Number(message.tabId), !!message.enabled);
        return { ok: true, state: await getState() };

      case "SLEEP_TAB":
        await sleepTab(Number(message.tabId));
        return { ok: true, state: await getState() };

      case "WAKE_TAB":
        await wakeTab(Number(message.tabId));
        return { ok: true, state: await getState() };

      case "GET_SLEEP_INFO":
        await ensureSleepDataCache();
        await ensureIncognitoCache();
        if (!sender?.tab || !isSleepPage(sender.tab)) return { ok: true, info: null };
        {
          const info = sleepPageData(sender.tab);
          let domain = "Original page";
          try { domain = new URL(info?.url || "").hostname || domain; } catch (_) {}
          return {
            ok: true,
            info: info ? {
              title: info.title,
              domain,
              url: info.url,
              restored: !!info.restoredAt
            } : null
          };
        }

      case "RESTORE_CURRENT_SLEEP_TAB":
        if (!Number.isInteger(sender?.tab?.id)) throw new Error("Could not identify this sleeping tab.");
        await restoreSleepTab(sender.tab.id);
        return { ok: true };

      case "CLOSE_TAB":
        await closeTab(Number(message.tabId));
        return { ok: true, state: await getState() };

      case "BULK_ACTION":
        await bulkAction(message.tabIds, message.action);
        return { ok: true, state: await getState() };

      case "OPEN_TAB":
        await chrome.tabs.update(Number(message.tabId), { active: true });
        return { ok: true };

      case "REBALANCE":
        await runReconcile(true, "manual-rebalance");
        return { ok: true, state: await getState() };

      case "WAKE_ALL":
        return { ok: true, woken: await wakeAllSleeping(), state: await getState() };

      default:
        return { ok: false, error: "Unknown request." };
    }
  })().then(sendResponse).catch(error => {
    sendResponse({ ok: false, error: error?.message || "Something went wrong." });
  });
  return true;
});
