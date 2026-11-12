// In-memory fake of the Thunderbird WebExtension APIs used by the extension.
// Install it on globalThis before importing background modules.

export function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn, ...extra) {
      listeners.push({ fn, extra });
    },
    fire(...args) {
      return listeners.map(({ fn }) => fn(...args));
    },
  };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending timers, promises and setTimeout(0) yields run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

let uid = 0;
export const uniqueId = (prefix) => `${prefix}${++uid}`;

export const GMAIL_FOLDERS = [
  { path: "/INBOX", specialUse: ["inbox"] },
  { path: "/업무" },
  { path: "/[Gmail]" },
  { path: "/[Gmail]/All Mail", specialUse: ["archives"] },
  { path: "/[Gmail]/Sent Mail", specialUse: ["sent"] },
  { path: "/[Gmail]/Spam", specialUse: ["junk"] },
  { path: "/[Gmail]/Trash", specialUse: ["trash"] },
  { path: "/개인" },
];

export function createFakeBrowser() {
  let nextListId = 1;
  let nextMessageId = 1;

  const world = {
    accounts: new Map(), // accountId -> MailAccount
    folders: new Map(), // accountId -> MailFolder[]
    contents: new Map(), // folderId -> Set<headerMessageId>
    emptyPagesBefore: new Map(), // folderId -> number of empty pages (with id) before the final one
    failingFolders: new Set(), // folderIds whose query throws
    displayed: new Map(), // tabId -> MessageHeader | Error
    storage: {},
    tabs: [],
    failingTabs: new Set(),
    dns: new Map(), // domain -> { ok?, json } | Error | "hang"
    gates: {
      query: null, // async (params) => void
      display: null, // async (tabId) => void
      storageGet: null, // async () => void
      accountsGet: null,
    },
    failures: { storageGet: null, foldersQuery: null, accountsGet: null, register: null },
    calls: {
      query: [],
      continueList: [],
      abortList: [],
      fetch: [],
      accountsGet: [],
      foldersQuery: [],
      getDisplayed: [],
      register: [],
      insertCSS: [],
      executeScript: [],
    },
    activeQueries: 0,
    maxActiveQueries: 0,
    queryWaiters: [],
  };

  const lists = new Map(); // listId -> { remaining, folderId, headerMessageId } | { page }

  function headerFor(folder, headerMessageId) {
    return {
      id: nextMessageId++,
      headerMessageId,
      folder: { id: folder.id, accountId: folder.accountId, path: folder.path },
    };
  }

  function finalPage(folderId, headerMessageId) {
    const folder = findFolder(folderId);
    if (world.contents.get(folderId)?.has(headerMessageId)) {
      // A list id is still present: more matches could follow (messagesPerPage: 1).
      const id = `list-${nextListId++}`;
      return { id, messages: [headerFor(folder, headerMessageId)] };
    }
    return { messages: [] };
  }

  function findFolder(folderId) {
    for (const folders of world.folders.values()) {
      const folder = folders.find((f) => f.id === folderId);
      if (folder) return folder;
    }
    return undefined;
  }

  const messages = {
    async query(params) {
      world.calls.query.push({ ...params });
      world.activeQueries++;
      world.maxActiveQueries = Math.max(world.maxActiveQueries, world.activeQueries);
      try {
        for (const waiter of [...world.queryWaiters]) {
          if (waiter.match(params)) {
            world.queryWaiters.splice(world.queryWaiters.indexOf(waiter), 1);
            waiter.resolve(params);
          }
        }
        if (world.gates.query) await world.gates.query(params);
        if (world.failingFolders.has(params.folderId)) {
          throw new Error(`query failed for ${params.folderId}`);
        }
        const empties = world.emptyPagesBefore.get(params.folderId) ?? 0;
        if (empties > 0) {
          const id = `list-${nextListId++}`;
          lists.set(id, { remaining: empties - 1, folderId: params.folderId, headerMessageId: params.headerMessageId });
          return { id, messages: [] };
        }
        return finalPage(params.folderId, params.headerMessageId);
      } finally {
        world.activeQueries--;
      }
    },
    async continueList(listId) {
      world.calls.continueList.push(listId);
      const list = lists.get(listId);
      if (!list) throw new Error(`unknown list ${listId}`);
      if (list.page) {
        lists.delete(listId);
        return list.page;
      }
      if (list.remaining > 0) {
        list.remaining--;
        return { id: listId, messages: [] };
      }
      lists.delete(listId);
      return finalPage(list.folderId, list.headerMessageId);
    },
    abortList(listId) {
      world.calls.abortList.push(listId);
      return Promise.resolve();
    },
    onMoved: createEvent(),
    onCopied: createEvent(),
    onDeleted: createEvent(),
    onNewMailReceived: createEvent(),
  };

  const storageOnChanged = createEvent();

  const browser = {
    runtime: { onMessage: createEvent() },
    tabs: {
      onRemoved: createEvent(),
      async query() {
        return world.tabs.map((tab) => ({ ...tab }));
      },
      async insertCSS(tabId, details) {
        world.calls.insertCSS.push({ tabId, ...details });
        if (world.failingTabs.has(tabId)) throw new Error("no message displayed");
      },
      async executeScript(tabId, details) {
        world.calls.executeScript.push({ tabId, ...details });
        if (world.failingTabs.has(tabId)) throw new Error("no message displayed");
        return [];
      },
    },
    messageDisplay: {
      async getDisplayedMessage(tabId) {
        world.calls.getDisplayed.push(tabId);
        // The message shown when the call was made, even if the tab moves on meanwhile.
        const value = world.displayed.get(tabId);
        if (world.gates.display) await world.gates.display(tabId);
        if (value instanceof Error) throw value;
        return value ?? null;
      },
    },
    messageDisplayScripts: {
      async register(details) {
        world.calls.register.push(details);
        if (world.failures.register) throw world.failures.register;
        return {};
      },
    },
    messages,
    accounts: {
      async get(accountId) {
        world.calls.accountsGet.push(accountId);
        if (world.gates.accountsGet) await world.gates.accountsGet(accountId);
        if (world.failures.accountsGet) throw world.failures.accountsGet;
        return world.accounts.get(accountId) ?? null;
      },
    },
    folders: {
      async query({ accountId }) {
        world.calls.foldersQuery.push(accountId);
        if (world.failures.foldersQuery) throw world.failures.foldersQuery;
        return (world.folders.get(accountId) ?? []).map((folder) => ({ ...folder }));
      },
      onCreated: createEvent(),
      onDeleted: createEvent(),
      onRenamed: createEvent(),
      onMoved: createEvent(),
    },
    storage: {
      local: {
        async get(key) {
          if (world.gates.storageGet) await world.gates.storageGet();
          if (world.failures.storageGet) throw world.failures.storageGet;
          return Object.hasOwn(world.storage, key) ? { [key]: structuredClone(world.storage[key]) } : {};
        },
        async set(items) {
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: world.storage[key], newValue: structuredClone(value) };
            world.storage[key] = structuredClone(value);
          }
          storageOnChanged.fire(changes, "local");
        },
      },
      onChanged: storageOnChanged,
    },
  };

  async function fetch(url, { signal } = {}) {
    world.calls.fetch.push(url);
    const domain = new URL(url).searchParams.get("name");
    const entry = world.dns.get(domain);
    if (entry === "hang") {
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (entry instanceof Error) throw entry;
    if (!entry) throw new Error(`no DNS entry for ${domain}`);
    return { ok: entry.ok ?? true, status: entry.ok === false ? 500 : 200, json: async () => entry.json };
  }

  /** Adds an account. Returns { accountId, folder(path) }. */
  function addAccount({ type = "imap", emails = ["user@gmail.com"], folders = GMAIL_FOLDERS } = {}) {
    const accountId = uniqueId("account");
    world.accounts.set(accountId, {
      id: accountId,
      type,
      identities: emails.map((email) => ({ email })),
    });
    const list = [{ id: `${accountId}:/`, accountId, path: "/", isRoot: true, specialUse: [] }];
    for (const def of folders) {
      list.push({
        id: `${accountId}:${def.path}`,
        accountId,
        path: def.path,
        specialUse: def.specialUse ?? [],
        isRoot: false,
        isVirtual: def.isVirtual ?? false,
        isTag: def.isTag ?? false,
        isUnified: def.isUnified ?? false,
      });
    }
    world.folders.set(accountId, list);
    const folder = (path) => {
      const found = list.find((f) => f.path === path);
      if (!found) throw new Error(`no folder ${path}`);
      return found;
    };
    return { accountId, folder };
  }

  /** Puts copies of a message (same Message-ID) into the given folders. */
  function addMessage(account, paths, headerMessageId = `<${uniqueId("msg")}@test>`) {
    for (const path of paths) {
      const folderId = account.folder(path).id;
      if (!world.contents.has(folderId)) world.contents.set(folderId, new Set());
      world.contents.get(folderId).add(headerMessageId);
    }
    return headerMessageId;
  }

  /** Makes `tabId` display the copy of `headerMessageId` in `path`. */
  function display(tabId, account, path, headerMessageId) {
    const header = headerFor(account.folder(path), headerMessageId);
    world.displayed.set(tabId, header);
    return header;
  }

  /** Resolves when a messages.query matching `match` starts. */
  function nextQuery(match = () => true) {
    const d = deferred();
    world.queryWaiters.push({ match, resolve: d.resolve });
    return d.promise;
  }

  /** Registers a paginated MessageList continuation for event tests. */
  function registerListPage(listId, page) {
    lists.set(listId, { page });
  }

  function queriesFor(headerMessageId) {
    return world.calls.query.filter((q) => q.headerMessageId === headerMessageId);
  }

  return { browser, fetch, world, addAccount, addMessage, display, nextQuery, registerListPage, queriesFor, headerFor };
}

/** Creates a fake and installs it as the global `browser` and `fetch`. */
export function installFakeBrowser() {
  const fake = createFakeBrowser();
  globalThis.browser = fake.browser;
  globalThis.fetch = fake.fetch;
  return fake;
}
