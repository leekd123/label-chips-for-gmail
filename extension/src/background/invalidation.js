// Cache invalidation listeners (spec 9.3).

import { clearFolderListCache } from "./folders.js";
import { invalidateAllLabels, invalidateMessage } from "./label-service.js";

/** Walks a (possibly paginated) MessageList without blocking the listener. */
function invalidateMessageList(list) {
  (async () => {
    let page = list;
    while (page) {
      for (const message of page.messages ?? []) {
        invalidateMessage(message?.folder?.accountId, message?.headerMessageId);
      }
      if (!page.id) {
        break;
      }
      page = await browser.messages.continueList(page.id);
    }
  })().catch((error) => {
    console.error("Label Chips: failed to walk message list for invalidation", error);
  });
}

export function invalidateEverything() {
  clearFolderListCache();
  invalidateAllLabels();
}

function addListenerSafely(event, listener, ...extra) {
  try {
    event.addListener(listener, ...extra);
  } catch (error) {
    console.error("Label Chips: failed to add listener", error);
  }
}

export function registerInvalidationListeners() {
  const messages = browser.messages;
  addListenerSafely(messages.onMoved, (original, moved) => {
    invalidateMessageList(original);
    invalidateMessageList(moved);
  });
  addListenerSafely(messages.onCopied, (original, copied) => {
    invalidateMessageList(original);
    invalidateMessageList(copied);
  });
  addListenerSafely(messages.onDeleted, (list) => {
    invalidateMessageList(list);
  });
  // monitorAllFolders = true (TB 121+): also watch Sent and other special folders.
  addListenerSafely(
    messages.onNewMailReceived,
    (folder, list) => {
      invalidateMessageList(list);
    },
    true,
  );

  for (const name of ["onCreated", "onDeleted", "onRenamed", "onMoved"]) {
    const event = browser.folders?.[name];
    if (event?.addListener) {
      addListenerSafely(event, () => invalidateEverything());
    }
  }
}
