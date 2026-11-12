// Label cache, shared in-flight searches and invalidation (spec 9, 10.7).

import { TtlLruCache } from "./cache.js";
import { getAccountFolders, selectLabelFolders } from "./folders.js";
import { searchLabels } from "./label-search.js";
import { getSettings } from "./settings.js";

const LABEL_CACHE_MAX_ENTRIES = 1000;

const labelCache = new TtlLruCache({ maxSize: LABEL_CACHE_MAX_ENTRIES }); // key -> string[]
const inFlight = new Map(); // key -> { promise, cancelled }

export function makeLabelKey(accountId, headerMessageId) {
  return `${accountId}_${headerMessageId}`;
}

/** Cached label paths (possibly empty), or undefined on a miss. */
export function getCachedLabels(key) {
  return labelCache.get(key);
}

/**
 * Returns the in-flight search for `key`, or starts a new one.
 * Resolves to label paths, or null if the search was aborted.
 */
export function getOrStartSearch({ key, accountId, headerMessageId, currentFolderId, shouldContinue }) {
  const existing = inFlight.get(key);
  if (existing) {
    return existing.promise;
  }

  const entry = { promise: null, cancelled: false };
  entry.promise = (async () => {
    try {
      // The target folder list is fixed with the settings in effect at start (spec 17.4).
      const settings = getSettings();
      const folders = selectLabelFolders(await getAccountFolders(accountId), settings);
      const paths = await searchLabels({ headerMessageId, currentFolderId, folders, shouldContinue });
      if (paths !== null && !entry.cancelled) {
        labelCache.set(key, paths, getSettings().labelCacheMinutes * 60 * 1000);
      }
      return paths;
    } finally {
      // Keep a newer search registered under the same key after an invalidation.
      if (inFlight.get(key) === entry) {
        inFlight.delete(key);
      }
    }
  })();
  inFlight.set(key, entry);
  return entry.promise;
}

/** Per-message invalidation (spec 9.3). */
export function invalidateMessage(accountId, headerMessageId) {
  if (!accountId || !headerMessageId) {
    return;
  }
  const key = makeLabelKey(accountId, headerMessageId);
  labelCache.delete(key);
  const entry = inFlight.get(key);
  if (entry) {
    entry.cancelled = true;
    inFlight.delete(key);
  }
}

/** Drops all cached labels and marks every in-flight search as cancelled. */
export function invalidateAllLabels() {
  labelCache.clear();
  for (const entry of inFlight.values()) {
    entry.cancelled = true;
  }
  inFlight.clear();
}
