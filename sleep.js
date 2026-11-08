const restoreButton = document.getElementById("restoreButton");
const restoreMessage = document.getElementById("restoreMessage");
const titleNode = document.getElementById("siteTitle");
const urlNode = document.getElementById("siteUrl");

(async () => {
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_SLEEP_INFO" });
    if (result?.info) {
      titleNode.textContent = result.info.title || "Sleeping tab";
      urlNode.textContent = result.info.domain || "Original page is safely parked.";
      document.title = `Sleeping · ${result.info.title || "tab"}`.slice(0, 120);
      if (result.info.restored) {
        restoreMessage.textContent = "This tab was restored earlier. Press Enter or click Restore to reload it.";
      }
    } else {
      titleNode.textContent = "Sleeping tab";
      urlNode.textContent = "Original page details are unavailable.";
    }
  } catch (_) {
    urlNode.textContent = "TabPilot is reconnecting…";
  }
})();

async function performRestore() {
  if (restoreButton.disabled) return;
  restoreButton.disabled = true;
  restoreMessage.textContent = "Restoring the original website…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "RESTORE_CURRENT_SLEEP_TAB" });
    if (result?.ok === false) throw new Error(result.error || "Could not restore this tab.");
  } catch (error) {
    restoreButton.disabled = false;
    restoreMessage.textContent = error?.message || "Could not restore this tab. Click above or press Enter to retry.";
  }
}

restoreButton.addEventListener("click", performRestore);

window.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    performRestore();
  }
});
