// User settings: defaults and validation (spec 17.1, 17.3).
// Shared by the background page and the options page.

export const SETTINGS_KEY = "settings";

export const LABEL_CACHE_MINUTES_MIN = 1;
export const LABEL_CACHE_MINUTES_MAX = 1440;

export const DEFAULT_SETTINGS = Object.freeze({
  excludeArchives: true,
  excludeJunk: true,
  excludeTrash: true,
  labelCacheMinutes: 30,
});

const VALIDATORS = {
  excludeArchives: isBoolean,
  excludeJunk: isBoolean,
  excludeTrash: isBoolean,
  labelCacheMinutes: isValidLabelCacheMinutes,
};

function isBoolean(value) {
  return typeof value === "boolean";
}

export function isValidLabelCacheMinutes(value) {
  return (
    Number.isInteger(value) &&
    value >= LABEL_CACHE_MINUTES_MIN &&
    value <= LABEL_CACHE_MINUTES_MAX
  );
}

/** Returns true if `value` is a valid value for the setting `key`. */
export function isValidSetting(key, value) {
  const validate = VALIDATORS[key];
  return validate !== undefined && validate(value);
}

/**
 * Validates a stored settings object item by item. Missing or invalid items
 * fall back to their defaults; unknown keys are dropped.
 */
export function normalizeSettings(raw) {
  const result = { ...DEFAULT_SETTINGS };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (Object.hasOwn(raw, key) && isValidSetting(key, raw[key])) {
      result[key] = raw[key];
    }
  }
  return result;
}

/**
 * Parses the text of the cache-minutes input. Returns the integer, or null if
 * the text is not a plain integer within range.
 */
export function parseLabelCacheMinutes(text) {
  const trimmed = String(text ?? "").trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return isValidLabelCacheMinutes(value) ? value : null;
}
