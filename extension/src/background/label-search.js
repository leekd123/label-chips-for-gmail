// Label search: query label folders one at a time (spec 8.2, 8.3, 10).

import { toLabelPath } from "./folders.js";

/** Macrotask boundary so Thunderbird can process UI events between folders. */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {object} params
 * @param {string} params.headerMessageId
 * @param {string} params.currentFolderId  id of the folder the message is displayed from
 * @param {Array} params.folders           target folders (already filtered), searched in order
 * @param {() => boolean} params.shouldContinue
 * @returns {Promise<string[]|null>} label paths in folder order, or null if aborted
 */
export async function searchLabels({ headerMessageId, currentFolderId, folders, shouldContinue }) {
  const paths = [];
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index];
    if (folder.id === currentFolderId) {
      paths.push(toLabelPath(folder.path));
      continue;
    }
    if (index > 0) {
      await yieldToEventLoop();
    }
    if (!shouldContinue()) {
      return null;
    }
    try {
      if (await folderContainsMessage(folder.id, headerMessageId)) {
        paths.push(toLabelPath(folder.path));
      }
    } catch (error) {
      console.error(`Label Chips: query failed for folder ${folder.path}`, error);
    }
  }
  return paths;
}

async function folderContainsMessage(folderId, headerMessageId) {
  // Sequential by design: never query several folders at once (spec 10.1).
  let page = await browser.messages.query({ headerMessageId, folderId, messagesPerPage: 1 });
  for (;;) {
    if (page?.messages?.length > 0) {
      if (page.id) {
        abortListQuietly(page.id);
      }
      return true;
    }
    if (!page?.id) {
      return false;
    }
    page = await browser.messages.continueList(page.id);
  }
}

function abortListQuietly(listId) {
  try {
    const result = browser.messages.abortList?.(listId);
    result?.catch?.(() => {});
  } catch {
    // Ignored: the remaining list will simply run out on its own.
  }
}
