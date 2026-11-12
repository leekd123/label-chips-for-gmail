// Account folder list cache, label-folder filter and [Gmail] detection (spec 8.1, 9.2).

import { TtlLruCache } from "./cache.js";

const FOLDER_LIST_TTL_MS = 10 * 60 * 1000;
const GMAIL_SYSTEM_FOLDER_RE = /^\/\[(Gmail|Google Mail)\](\/|$)/;

// accountId -> unfiltered result of folders.query({ accountId })
const folderListCache = new TtlLruCache({ ttl: FOLDER_LIST_TTL_MS });
// Bumped on every clear so an in-flight query cannot store a stale list.
let generation = 0;

export async function getAccountFolders(accountId) {
  const cached = folderListCache.get(accountId);
  if (cached !== undefined) {
    return cached;
  }
  const startGeneration = generation;
  const folders = await browser.folders.query({ accountId });
  if (startGeneration === generation) {
    folderListCache.set(accountId, folders);
  }
  return folders;
}

export function clearFolderListCache() {
  generation++;
  folderListCache.clear();
}

export function hasGmailSystemFolder(folders) {
  return folders.some((folder) => GMAIL_SYSTEM_FOLDER_RE.test(folder.path ?? ""));
}

/** Folders to search for copies of a message, in folders.query order. */
export function selectLabelFolders(folders, settings) {
  const excluded = new Set();
  if (settings.excludeArchives) excluded.add("archives");
  if (settings.excludeJunk) excluded.add("junk");
  if (settings.excludeTrash) excluded.add("trash");

  return folders.filter((folder) => {
    if (!folder.id) return false;
    if (folder.isRoot || folder.isVirtual || folder.isTag || folder.isUnified) return false;
    const specialUse = Array.isArray(folder.specialUse) ? folder.specialUse : [];
    return !specialUse.some((use) => excluded.has(use));
  });
}

/** Label path = MailFolder.path without its single leading "/". */
export function toLabelPath(folderPath) {
  const path = folderPath ?? "";
  return path.startsWith("/") ? path.slice(1) : path;
}
