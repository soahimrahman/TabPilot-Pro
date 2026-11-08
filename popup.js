const $ = id => document.getElementById(id);
async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (result?.ok === false) throw new Error(result.error || "Request failed.");
  return result;
}
async function refresh() {
  try {
    const state = await send("GET_STATE");
    const s = state.settings;
    $("liveCount").textContent = state.counts.live;
    $("sleepCount").textContent = state.counts.sleeping;
    $("limitSlider").value = s.maxLiveTabs;
    $("limitValue").textContent = s.maxLiveTabs;
    $("sleepToggle").checked = s.sleepModeEnabled;
    $("networkToggle").checked = s.blockNetworkWhileSleeping;
    $("switchSleepToggle").checked = s.sleepPreviousTabOnSwitch;
    $("refillToggle").checked = s.autoRefillOnClose;
    $("statusDot").classList.toggle("on", s.sleepModeEnabled);
    $("modeLabel").textContent = s.sleepModeEnabled ? "ON" : "OFF";
    $("modeLabel").classList.toggle("on", s.sleepModeEnabled);
    $("trackFill").style.width = `${Math.min(100, state.counts.live / Math.max(1, s.maxLiveTabs) * 100)}%`;
    $("heroMessage").textContent = s.sleepModeEnabled
      ? "Inactive pages are unloaded. Sleeping pages cannot run normal page scripts."
      : "Sleep Mode is off. Turn it on to unload inactive pages.";
    $("message").textContent = `${state.counts.managed} manageable tabs · ${state.counts.unsupported} browser pages not manageable.`;
  } catch (error) {
    $("message").textContent = "Could not connect to TabPilot. Reload the extension from chrome://extensions.";
  }
}
$("limitSlider").addEventListener("input", () => $("limitValue").textContent = $("limitSlider").value);
$("applyButton").addEventListener("click", async () => {
  $("applyButton").disabled = true;
  $("applyButton").textContent = "Applying…";
  try {
    await send("UPDATE_SETTINGS", {
      sleepModeEnabled: $("sleepToggle").checked,
      maxLiveTabs: Number($("limitSlider").value),
      blockNetworkWhileSleeping: $("networkToggle").checked,
      sleepPreviousTabOnSwitch: $("switchSleepToggle").checked,
      autoRefillOnClose: $("refillToggle").checked
    });
    await refresh();
    $("message").textContent = "Settings saved. Sleep Mode is updating your tabs.";
  } catch (error) {
    $("message").textContent = error.message;
  } finally {
    $("applyButton").disabled = false;
    $("applyButton").textContent = "Save & apply settings";
  }
});
$("dashboardButton").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("recoveryButton").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html#recovery") }));
refresh();
