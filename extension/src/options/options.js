// Options page (spec 17.2). Saves on every change; no save button.

import {
  DEFAULT_SETTINGS,
  LABEL_CACHE_MINUTES_MAX,
  LABEL_CACHE_MINUTES_MIN,
  SETTINGS_KEY,
  normalizeSettings,
  parseLabelCacheMinutes,
} from "../shared/settings.js";

const CHECKBOX_KEYS = ["excludeArchives", "excludeJunk", "excludeTrash"];
const MINUTES_ERROR = `${LABEL_CACHE_MINUTES_MIN}–${LABEL_CACHE_MINUTES_MAX} 사이의 정수를 입력하세요. (저장되지 않음)`;

// Last successfully saved (or loaded) settings.
let saved = { ...DEFAULT_SETTINGS };
// Saves run one after another so a later change never loses an earlier one.
let saveQueue = Promise.resolve();

const $ = (id) => document.getElementById(id);

function render(settings) {
  for (const key of CHECKBOX_KEYS) {
    $(key).checked = settings[key];
  }
  $("labelCacheMinutes").value = String(settings.labelCacheMinutes);
  showMinutesError(false);
}

function showMinutesError(show) {
  $("labelCacheMinutes-error").textContent = show ? MINUTES_ERROR : "";
  $("labelCacheMinutes").setAttribute("aria-invalid", show ? "true" : "false");
}

function enqueueSave(update) {
  saveQueue = saveQueue
    .then(async () => {
      const next = { ...saved, ...update };
      await browser.storage.local.set({ [SETTINGS_KEY]: next });
      saved = next;
    })
    .catch((error) => {
      console.error("Label Chips: failed to save settings", error);
    });
  return saveQueue;
}

async function load() {
  try {
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    saved = normalizeSettings(stored?.[SETTINGS_KEY]);
  } catch (error) {
    console.error("Label Chips: failed to load settings", error);
    saved = { ...DEFAULT_SETTINGS };
  }
  render(saved);
}

function init() {
  for (const key of CHECKBOX_KEYS) {
    $(key).addEventListener("change", (event) => {
      enqueueSave({ [key]: event.target.checked });
    });
  }

  $("labelCacheMinutes").addEventListener("change", (event) => {
    const value = parseLabelCacheMinutes(event.target.value);
    if (value === null) {
      showMinutesError(true);
      return;
    }
    showMinutesError(false);
    enqueueSave({ labelCacheMinutes: value });
  });

  $("reset").addEventListener("click", () => {
    render(DEFAULT_SETTINGS);
    enqueueSave({ ...DEFAULT_SETTINGS });
  });

  load();
}

init();
