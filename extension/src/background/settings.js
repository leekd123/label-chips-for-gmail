// In-memory copy of the user settings (spec 17.4).

import { DEFAULT_SETTINGS, SETTINGS_KEY, normalizeSettings } from "../shared/settings.js";

let current = { ...DEFAULT_SETTINGS };
let loadPromise = null;

/** Current valid settings. Read synchronously by search and cache logic. */
export function getSettings() {
  return current;
}

/**
 * Loads the stored settings once. Repeated calls return the same promise,
 * so it doubles as the "settings ready" signal. Never rejects.
 */
export function loadSettings() {
  if (loadPromise === null) {
    loadPromise = (async () => {
      try {
        const stored = await browser.storage.local.get(SETTINGS_KEY);
        current = normalizeSettings(stored?.[SETTINGS_KEY]);
      } catch (error) {
        console.error("Label Chips: failed to load settings, using defaults", error);
        current = { ...DEFAULT_SETTINGS };
      }
    })();
  }
  return loadPromise;
}

/** Calls `onChange` after the in-memory settings have been updated. */
export function watchSettings(onChange) {
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !Object.hasOwn(changes, SETTINGS_KEY)) {
      return;
    }
    current = normalizeSettings(changes[SETTINGS_KEY].newValue);
    onChange();
  });
}
