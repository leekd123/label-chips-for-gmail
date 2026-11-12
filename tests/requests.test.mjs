// Spec 4, 5, 7, 9.3, 10, 17.4 through the real background wiring (main.js).
// Covers acceptance scenarios 1-5, 8-12, 20, 21, 26.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { deferred, installFakeBrowser, settle, uniqueId } from "./helpers/fake-browser.mjs";

const fake = installFakeBrowser();
await import("../extension/src/background/main.js");
await settle();

const onMessage = fake.browser.runtime.onMessage.listeners[0].fn;
const getLabels = (tabId) => onMessage({ command: "getLabels" }, { tab: { id: tabId } });
const newTab = () => Number(uniqueId("").slice(0)) + 1000;
const labels = (response) => response.labels.map((l) => (l.active ? `*${l.path}` : l.path));

beforeEach((t) => {
  for (const list of Object.values(fake.world.calls)) list.length = 0;
  fake.world.gates.query = null;
  fake.world.gates.display = null;
  t.mock.method(console, "error", () => {});
});

async function setSettings(settings) {
  await fake.browser.storage.local.set({ settings });
}

test("other commands are left to other listeners", () => {
  assert.equal(onMessage({ command: "other" }, { tab: { id: 1 } }), undefined);
  assert.equal(onMessage(undefined, { tab: { id: 1 } }), undefined);
  assert.equal(onMessage(null, {}), undefined);
});

test("getLabels returns a Promise; no tab id gives no labels", async () => {
  const pending = onMessage({ command: "getLabels" }, {});
  assert.ok(pending instanceof Promise);
  assert.deepEqual(await pending, { labels: [] });
  assert.deepEqual(await onMessage({ command: "getLabels" }, { tab: {} }), { labels: [] });
});

test("scenario 1: current folder first (active), then other labels", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/업무", "/[Gmail]/All Mail"]);
  const tab = newTab();
  fake.display(tab, account, "/INBOX", id);
  const response = await getLabels(tab);
  assert.deepEqual(response, {
    labels: [
      { path: "INBOX", active: true },
      { path: "업무", active: false },
    ],
  });
  const queried = fake.world.calls.query.map((q) => q.folderId);
  assert.ok(!queried.includes(account.folder("/INBOX").id), "current folder is not queried");
  for (const excluded of ["/[Gmail]/All Mail", "/[Gmail]/Spam", "/[Gmail]/Trash"]) {
    assert.ok(!queried.includes(account.folder(excluded).id), `${excluded} not queried by default`);
  }
});

test("scenario 2: same message from another folder uses the cache", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/업무"]);
  const tab = newTab();
  fake.display(tab, account, "/INBOX", id);
  await getLabels(tab);
  const queriesAfterFirst = fake.world.calls.query.length;
  fake.display(tab, account, "/업무", id);
  assert.deepEqual(labels(await getLabels(tab)), ["*업무", "INBOX"]);
  assert.equal(fake.world.calls.query.length, queriesAfterFirst, "no new search");
});

test("cache hit skips Google account detection", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX"]);
  const tab = newTab();
  fake.display(tab, account, "/INBOX", id);
  await getLabels(tab);
  const original = fake.browser.folders.query;
  let called = 0;
  fake.browser.folders.query = async (...args) => {
    called++;
    return original(...args);
  };
  try {
    await getLabels(tab);
  } finally {
    fake.browser.folders.query = original;
  }
  assert.equal(called, 0);
});

test("scenario 3: message without other labels shows only the current folder", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/업무"]);
  const tab = newTab();
  fake.display(tab, account, "/업무", id);
  assert.deepEqual(labels(await getLabels(tab)), ["*업무"]);
});

test("scenario 4: excluded folders show only as the current folder", async () => {
  const account = fake.addAccount();
  const inTrash = fake.addMessage(account, ["/[Gmail]/Trash", "/INBOX"]);
  const tab = newTab();
  fake.display(tab, account, "/[Gmail]/Trash", inTrash);
  assert.deepEqual(labels(await getLabels(tab)), ["*[Gmail]/Trash", "INBOX"]);

  const other = fake.addMessage(account, ["/INBOX", "/[Gmail]/Trash", "/[Gmail]/Spam", "/[Gmail]/All Mail"]);
  fake.display(tab, account, "/INBOX", other);
  assert.deepEqual(labels(await getLabels(tab)), ["*INBOX"]);
});

test("scenario 5: non-Google IMAP, POP3 and local folders show nothing and are not searched", async () => {
  const domain = `${uniqueId("plain")}.example`;
  fake.world.dns.set(domain, { json: { Status: 0, Answer: [{ data: "10 mx.example.net." }] } });
  const plain = [{ path: "/INBOX", specialUse: ["inbox"] }, { path: "/Work" }];
  const imap = fake.addAccount({ emails: [`me@${domain}`], folders: plain });
  const pop = fake.addAccount({ type: "pop3", emails: ["me@gmail.com"], folders: plain });
  const local = fake.addAccount({ type: "none", emails: [], folders: plain });
  for (const account of [imap, pop, local]) {
    const id = fake.addMessage(account, ["/INBOX", "/Work"]);
    const tab = newTab();
    fake.display(tab, account, "/INBOX", id);
    assert.deepEqual(await getLabels(tab), { labels: [] });
  }
  assert.equal(fake.world.calls.query.length, 0);
});

test("messages without folder/accountId or Message-ID (e.g. .eml) show nothing", async () => {
  const tab = newTab();
  fake.world.displayed.set(tab, { id: 1, headerMessageId: "<x@y>", folder: null });
  assert.deepEqual(await getLabels(tab), { labels: [] });
  fake.world.displayed.set(tab, { id: 2, headerMessageId: "", folder: { id: "f", accountId: "a", path: "/INBOX" } });
  assert.deepEqual(await getLabels(tab), { labels: [] });
  fake.world.displayed.delete(tab);
  assert.deepEqual(await getLabels(tab), { labels: [] });
});

test("errors are logged and answered with no labels", async (t) => {
  const tab = newTab();
  fake.world.displayed.set(tab, new Error("display failed"));
  assert.deepEqual(await getLabels(tab), { labels: [] });
  assert.ok(console.error.mock.callCount() >= 1);
});

test("a newer request on the same tab makes the older one stale", async () => {
  const account = fake.addAccount();
  const first = fake.addMessage(account, ["/INBOX", "/업무"]);
  const second = fake.addMessage(account, ["/INBOX", "/개인"]);
  const tab = newTab();
  const gate = deferred();
  fake.world.gates.display = () => gate.promise;
  fake.display(tab, account, "/INBOX", first);
  const older = getLabels(tab);
  await settle(2);
  fake.world.gates.display = null;
  fake.display(tab, account, "/INBOX", second);
  const newer = getLabels(tab);
  gate.resolve();
  assert.deepEqual(await older, { labels: [] });
  assert.deepEqual(labels(await newer), ["*INBOX", "개인"]);
});

test("scenario 11: two tabs showing one message share a single search", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/업무"]);
  const [tab1, tab2] = [newTab(), newTab()];
  fake.display(tab1, account, "/INBOX", id);
  fake.display(tab2, account, "/업무", id);
  const [r1, r2] = await Promise.all([getLabels(tab1), getLabels(tab2)]);
  assert.deepEqual(labels(r1), ["*INBOX", "업무"]);
  assert.deepEqual(labels(r2), ["*업무", "INBOX"]);
  const perFolder = new Map();
  for (const q of fake.queriesFor(id)) perFolder.set(q.folderId, (perFolder.get(q.folderId) ?? 0) + 1);
  assert.ok([...perFolder.values()].every((n) => n === 1), "each folder queried once");
  assert.equal(fake.world.maxActiveQueries, 1);
});

/** Starts a search for `id` on `tab` and waits until its first folder query is held. */
async function startHeldSearch(tab, account, id) {
  const gate = deferred();
  fake.world.gates.query = (params) => (params.headerMessageId === id ? gate.promise : undefined);
  const started = fake.nextQuery((q) => q.headerMessageId === id);
  fake.display(tab, account, "/INBOX", id);
  const response = getLabels(tab);
  await started;
  return { response, release: gate.resolve };
}

test("scenario 8: moving to another message abandons the remaining folder queries", async () => {
  const account = fake.addAccount();
  const a = fake.addMessage(account, ["/INBOX", "/개인"]);
  const b = fake.addMessage(account, ["/INBOX", "/업무"]);
  const tab = newTab();
  const held = await startHeldSearch(tab, account, a);
  fake.display(tab, account, "/INBOX", b);
  const responseB = getLabels(tab);
  await settle(2);
  held.release();
  assert.deepEqual(await held.response, { labels: [] }, "stale response for A");
  assert.deepEqual(labels(await responseB), ["*INBOX", "업무"]);
  await settle();
  assert.equal(fake.queriesFor(a).length, 1, "A's search stopped after the in-flight folder");
});

test("scenario 12: closing the tab stops the search", async () => {
  const account = fake.addAccount();
  const a = fake.addMessage(account, ["/INBOX", "/개인"]);
  const tab = newTab();
  const held = await startHeldSearch(tab, account, a);
  fake.browser.tabs.onRemoved.fire(tab, {});
  held.release();
  assert.deepEqual(await held.response, { labels: [] });
  await settle();
  assert.equal(fake.queriesFor(a).length, 1);
});

test("search continues while another tab still shows the message", async () => {
  const account = fake.addAccount();
  const a = fake.addMessage(account, ["/INBOX", "/개인"]);
  const b = fake.addMessage(account, ["/INBOX"]);
  const [tab1, tab2] = [newTab(), newTab()];
  const held = await startHeldSearch(tab1, account, a);
  fake.display(tab2, account, "/INBOX", a);
  const response2 = getLabels(tab2);
  await settle(2);
  fake.display(tab1, account, "/INBOX", b);
  await getLabels(tab1);
  held.release();
  assert.deepEqual(labels(await response2), ["*INBOX", "개인"]);
  assert.deepEqual(await held.response, { labels: [] });
});

test("scenario 26: A -> B -> A before the search ends shows A's labels", async () => {
  const account = fake.addAccount();
  const a = fake.addMessage(account, ["/INBOX", "/개인"]);
  const b = fake.addMessage(account, ["/INBOX"]);
  const tab = newTab();
  const held = await startHeldSearch(tab, account, a);
  fake.display(tab, account, "/INBOX", b);
  await getLabels(tab);
  fake.display(tab, account, "/INBOX", a);
  const again = getLabels(tab);
  await settle(2);
  held.release();
  assert.deepEqual(labels(await again), ["*INBOX", "개인"]);
  assert.deepEqual(await held.response, { labels: [] });
});

// The exact "joined a search that already decided to abort" retry (spec 5 step 9) needs the join to
// land between the abort check and the search's cleanup microtasks; it is not reproduced here.
test("scenario 26 (late return): returning after A's search aborted starts a new search", async () => {
  const account = fake.addAccount();
  const a = fake.addMessage(account, ["/INBOX", "/개인"]);
  const b = fake.addMessage(account, ["/INBOX"]);
  const tab = newTab();
  const held = await startHeldSearch(tab, account, a);
  // Move to B, release A so its search aborts, and come back to A in between.
  fake.display(tab, account, "/INBOX", b);
  await getLabels(tab);
  fake.world.gates.query = null;
  held.release();
  await settle();
  fake.display(tab, account, "/INBOX", a);
  assert.deepEqual(labels(await getLabels(tab)), ["*INBOX", "개인"]);
});

test("scenario 9: copy/move/delete events invalidate the message", async () => {
  const events = [
    (msg) => fake.browser.messages.onCopied.fire({ messages: [msg] }, { messages: [] }),
    (msg) => fake.browser.messages.onCopied.fire({ messages: [] }, { messages: [msg] }),
    (msg) => fake.browser.messages.onMoved.fire({ messages: [msg] }, { messages: [] }),
    (msg) => fake.browser.messages.onMoved.fire({ messages: [] }, { messages: [msg] }),
    (msg) => fake.browser.messages.onDeleted.fire({ messages: [msg] }),
    (msg) => fake.browser.messages.onNewMailReceived.fire({}, { messages: [msg] }),
  ];
  for (const fireEvent of events) {
    const account = fake.addAccount();
    const id = fake.addMessage(account, ["/INBOX"]);
    const tab = newTab();
    const header = fake.display(tab, account, "/INBOX", id);
    assert.deepEqual(labels(await getLabels(tab)), ["*INBOX"]);
    fake.addMessage(account, ["/업무"], id); // label added on the server
    await getLabels(tab);
    assert.deepEqual(labels(await getLabels(tab)), ["*INBOX"], "still cached before the event");
    fireEvent(header);
    await settle(2);
    assert.deepEqual(labels(await getLabels(tab)), ["*INBOX", "업무"], fireEvent.toString());
  }
});

test("paginated event message lists are walked with continueList", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX"]);
  const tab = newTab();
  const header = fake.display(tab, account, "/INBOX", id);
  await getLabels(tab);
  fake.addMessage(account, ["/개인"], id);
  fake.registerListPage("event-list", { messages: [header] });
  fake.browser.messages.onMoved.fire({ id: "event-list", messages: [] }, { messages: [] });
  await settle(2);
  assert.deepEqual(labels(await getLabels(tab)), ["*INBOX", "개인"]);
});

test("onNewMailReceived is registered with monitorAllFolders = true", () => {
  const { listeners } = fake.browser.messages.onNewMailReceived;
  assert.equal(listeners.length, 1);
  assert.deepEqual(listeners[0].extra, [true]);
});

test("invalidation ignores messages without accountId or Message-ID", () => {
  assert.doesNotThrow(() => {
    fake.browser.messages.onDeleted.fire({ messages: [{ headerMessageId: "<x>" }, { folder: { accountId: "a" } }, null] });
  });
});

test("an invalidated in-flight search answers its waiters but is not cached", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/개인"]);
  const tab = newTab();
  const held = await startHeldSearch(tab, account, id);
  fake.browser.messages.onCopied.fire({ messages: [fake.headerFor(account.folder("/INBOX"), id)] }, { messages: [] });
  await settle(2);
  fake.world.gates.query = null;
  held.release();
  assert.deepEqual(labels(await held.response), ["*INBOX", "개인"]);
  const before = fake.queriesFor(id).length;
  await getLabels(tab);
  assert.ok(fake.queriesFor(id).length > before, "searched again");
});

test("scenario 10: folder events drop the folder list and all labels", async () => {
  for (const name of ["onCreated", "onDeleted", "onRenamed", "onMoved"]) {
    const account = fake.addAccount();
    const id = fake.addMessage(account, ["/INBOX"]);
    const tab = newTab();
    fake.display(tab, account, "/INBOX", id);
    await getLabels(tab);
    // A new label folder appears.
    fake.world.folders.get(account.accountId).push({
      id: `${account.accountId}:/새 라벨`, accountId: account.accountId, path: "/새 라벨", specialUse: [],
    });
    fake.world.contents.set(`${account.accountId}:/새 라벨`, new Set([id]));
    assert.deepEqual(labels(await getLabels(tab)), ["*INBOX"], `${name}: cached before the event`);
    fake.browser.folders[name].fire({});
    assert.deepEqual(labels(await getLabels(tab)), ["*INBOX", "새 라벨"], name);
  }
});

test("scenario 20/21: settings changes apply to the next request without restart", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/[Gmail]/Trash"]);
  const tab = newTab();
  fake.display(tab, account, "/INBOX", id);
  assert.deepEqual(labels(await getLabels(tab)), ["*INBOX"], "defaults exclude Trash");
  await setSettings({ excludeArchives: true, excludeJunk: true, excludeTrash: false, labelCacheMinutes: 30 });
  try {
    assert.deepEqual(labels(await getLabels(tab)), ["*INBOX", "[Gmail]/Trash"]);
  } finally {
    await setSettings({ excludeArchives: true, excludeJunk: true, excludeTrash: true, labelCacheMinutes: 30 });
  }
  assert.deepEqual(labels(await getLabels(tab)), ["*INBOX"], "changing back invalidates again");
});

test("settings change keeps the folder list and Google account caches", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX"]);
  const tab = newTab();
  fake.display(tab, account, "/INBOX", id);
  await getLabels(tab);
  fake.world.calls.foldersQuery.length = 0;
  fake.world.calls.accountsGet.length = 0;
  await setSettings({ excludeArchives: true, excludeJunk: true, excludeTrash: true, labelCacheMinutes: 31 });
  await setSettings({ excludeArchives: true, excludeJunk: true, excludeTrash: true, labelCacheMinutes: 30 });
  await getLabels(tab);
  assert.equal(fake.world.calls.foldersQuery.length, 0);
});

test("a search started before a settings change finishes with its start settings and is not cached", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/[Gmail]/Trash"]);
  const tab = newTab();
  const held = await startHeldSearch(tab, account, id);
  await setSettings({ excludeArchives: true, excludeJunk: true, excludeTrash: false, labelCacheMinutes: 30 });
  try {
    fake.world.gates.query = null;
    held.release();
    assert.deepEqual(labels(await held.response), ["*INBOX"], "old settings: Trash excluded");
    assert.deepEqual(labels(await getLabels(tab)), ["*INBOX", "[Gmail]/Trash"], "not cached; new settings");
  } finally {
    await setSettings({ excludeArchives: true, excludeJunk: true, excludeTrash: true, labelCacheMinutes: 30 });
  }
});

test("label cache lifetime follows labelCacheMinutes", async (t) => {
  await setSettings({ excludeArchives: true, excludeJunk: true, excludeTrash: true, labelCacheMinutes: 1 });
  const clock = { now: Date.now() };
  t.mock.method(Date, "now", () => clock.now);
  try {
    const account = fake.addAccount();
    const id = fake.addMessage(account, ["/INBOX"]);
    const tab = newTab();
    fake.display(tab, account, "/INBOX", id);
    await getLabels(tab);
    const searched = fake.queriesFor(id).length;
    clock.now += 60 * 1000 - 1;
    await getLabels(tab);
    assert.equal(fake.queriesFor(id).length, searched, "cached within 1 minute");
    clock.now += 1;
    await getLabels(tab);
    assert.ok(fake.queriesFor(id).length > searched, "searched again after 1 minute");
  } finally {
    await setSettings({ excludeArchives: true, excludeJunk: true, excludeTrash: true, labelCacheMinutes: 30 });
  }
});

test("a failing label folder is skipped, not fatal", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/업무", "/개인"]);
  fake.world.failingFolders.add(account.folder("/업무").id);
  const tab = newTab();
  fake.display(tab, account, "/INBOX", id);
  try {
    assert.deepEqual(labels(await getLabels(tab)), ["*INBOX", "개인"]);
  } finally {
    fake.world.failingFolders.clear();
  }
});
