// Background entry point (spec 12).

import { registerInvalidationListeners } from "./invalidation.js";
import { invalidateAllLabels } from "./label-service.js";
import { forgetTab, handleRuntimeMessage } from "./request-handler.js";
import { loadSettings, watchSettings } from "./settings.js";

// Absolute paths so they resolve from the extension root for every API.
const CONTENT_JS = "/src/content/labels.js";
const CONTENT_CSS = "/src/content/labels.css";

// 1. Listeners
browser.runtime.onMessage.addListener(handleRuntimeMessage);
browser.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));
registerInvalidationListeners();

// 2. Settings: start loading (not awaited) and watch for changes.
loadSettings();
watchSettings(() => {
  // Folder list and Google-account caches are independent of settings (spec 17.4).
  invalidateAllLabels();
});

// 3-4. Register the message display script, then cover already-open messages.
(async () => {
  try {
    await browser.messageDisplayScripts.register({
      js: [{ file: CONTENT_JS }],
      css: [{ file: CONTENT_CSS }],
    });
  } catch (error) {
    console.error("Label Chips: messageDisplayScripts.register failed", error);
  }
  injectIntoOpenMessageTabs().catch((error) => {
    console.error("Label Chips: failed to inject into open tabs", error);
  });
})();

async function injectIntoOpenMessageTabs() {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.type !== "mail" && tab.type !== "messageDisplay") {
      continue;
    }
    try {
      await browser.tabs.insertCSS(tab.id, { file: CONTENT_CSS });
      await browser.tabs.executeScript(tab.id, { file: CONTENT_JS });
    } catch {
      // No message displayed in this tab, etc. Move on to the next one.
    }
  }
}
