// getLabels request handling with per-tab state (spec 4, 5, 7).

import { toLabelPath } from "./folders.js";
import { isGoogleAccount } from "./google-account.js";
import { getCachedLabels, getOrStartSearch, makeLabelKey } from "./label-service.js";
import { loadSettings } from "./settings.js";

/** tabId -> { requestId: number, displayedKey: string|null } */
const tabStates = new Map();

const emptyResponse = () => ({ labels: [] });

export function handleRuntimeMessage(message, sender) {
  if (message?.command !== "getLabels") {
    return undefined;
  }
  return handleGetLabels(sender?.tab?.id).catch((error) => {
    console.error("Label Chips: getLabels failed", error);
    return emptyResponse();
  });
}

export function forgetTab(tabId) {
  tabStates.delete(tabId);
}

function isKeyDisplayedInAnyTab(key) {
  for (const state of tabStates.values()) {
    if (state.displayedKey === key) {
      return true;
    }
  }
  return false;
}

async function handleGetLabels(tabId) {
  await loadSettings();

  if (tabId === undefined || tabId === null) {
    return emptyResponse();
  }

  let state = tabStates.get(tabId);
  if (!state) {
    state = { requestId: 0, displayedKey: null };
    tabStates.set(tabId, state);
  }
  const requestId = ++state.requestId;
  // Stale: a newer request arrived for this tab, or the tab was closed.
  const isStale = () => tabStates.get(tabId) !== state || state.requestId !== requestId;

  const header = await browser.messageDisplay.getDisplayedMessage(tabId);
  if (isStale()) {
    return emptyResponse();
  }

  const accountId = header?.folder?.accountId;
  const headerMessageId = header?.headerMessageId;
  if (!accountId || !headerMessageId) {
    state.displayedKey = null;
    return emptyResponse();
  }

  // Never key on messageHeader.id: every folder copy has its own id.
  const key = makeLabelKey(accountId, headerMessageId);
  const currentPath = toLabelPath(header.folder.path);
  state.displayedKey = key;

  const cached = getCachedLabels(key);
  if (cached !== undefined) {
    return buildResponse(cached, currentPath);
  }

  const isGoogle = await isGoogleAccount(accountId);
  if (!isGoogle || isStale()) {
    return emptyResponse();
  }

  const runSearch = () =>
    getOrStartSearch({
      key,
      accountId,
      headerMessageId,
      currentFolderId: header.folder.id,
      shouldContinue: () => isKeyDisplayedInAnyTab(key),
    });

  let paths = await runSearch();
  if (isStale()) {
    return emptyResponse();
  }
  if (paths === null) {
    // Joined a search that had already decided to abort (A -> B -> A): retry once.
    paths = await runSearch();
    if (paths === null || isStale()) {
      return emptyResponse();
    }
  }
  return buildResponse(paths, currentPath);
}

/** Current folder first, then the rest in folder order (spec 7). */
function buildResponse(paths, currentPath) {
  const ordered = currentPath ? [currentPath, ...paths.filter((path) => path !== currentPath)] : [...paths];
  return {
    labels: ordered.map((path) => ({ path, active: path === currentPath })),
  };
}
