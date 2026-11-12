// Spec 8.2, 8.3, 10.1-10.6: per-folder sequential search.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { installFakeBrowser } from "./helpers/fake-browser.mjs";

const fake = installFakeBrowser();
const { searchLabels } = await import("../extension/src/background/label-search.js");

let account;
beforeEach(() => {
  account = fake.addAccount({ folders: [{ path: "/A" }, { path: "/B" }, { path: "/C" }, { path: "/D" }] });
  fake.world.calls.query.length = 0;
  fake.world.calls.continueList.length = 0;
  fake.world.calls.abortList.length = 0;
  fake.world.maxActiveQueries = 0;
  fake.world.gates.query = null;
});

const targets = () => ["/A", "/B", "/C", "/D"].map((p) => account.folder(p));

test("returns label paths of folders containing the message, in folder order", async () => {
  const id = fake.addMessage(account, ["/D", "/B"]);
  const result = await searchLabels({ headerMessageId: id, currentFolderId: null, folders: targets(), shouldContinue: () => true });
  assert.deepEqual(result, ["B", "D"]);
});

test("every query names one folder, the Message-ID and messagesPerPage: 1, without dates", async () => {
  const id = fake.addMessage(account, ["/B"]);
  await searchLabels({ headerMessageId: id, currentFolderId: null, folders: targets(), shouldContinue: () => true });
  assert.equal(fake.world.calls.query.length, 4);
  for (const q of fake.world.calls.query) {
    assert.deepEqual(Object.keys(q).sort(), ["folderId", "headerMessageId", "messagesPerPage"]);
    assert.equal(q.messagesPerPage, 1);
    assert.equal(q.headerMessageId, id);
    assert.ok(q.folderId);
  }
  assert.deepEqual(fake.world.calls.query.map((q) => q.folderId), targets().map((f) => f.id));
});

test("folders are queried strictly one at a time", async () => {
  const id = fake.addMessage(account, ["/A", "/C"]);
  fake.world.gates.query = () => new Promise((r) => setTimeout(r, 2));
  await searchLabels({ headerMessageId: id, currentFolderId: null, folders: targets(), shouldContinue: () => true });
  assert.equal(fake.world.maxActiveQueries, 1);
});

test("yields to the event loop (macrotask) between folder queries", async () => {
  const id = fake.addMessage(account, []);
  let ticks = 0;
  const seen = [];
  fake.world.gates.query = (params) => {
    seen.push(ticks);
    // Scheduled while a query runs; must fire before the next folder is queried.
    setTimeout(() => ticks++, 0);
  };
  await searchLabels({ headerMessageId: id, currentFolderId: null, folders: targets(), shouldContinue: () => true });
  assert.deepEqual(seen, [0, 1, 2, 3]);
});

test("the current folder is added without a query or a continue check", async () => {
  const id = fake.addMessage(account, ["/B", "/C"]);
  let checks = 0;
  const result = await searchLabels({
    headerMessageId: id,
    currentFolderId: account.folder("/B").id,
    folders: targets(),
    shouldContinue: () => {
      checks++;
      return true;
    },
  });
  assert.deepEqual(result, ["B", "C"]);
  assert.ok(!fake.world.calls.query.some((q) => q.folderId === account.folder("/B").id));
  assert.equal(checks, 3);
});

test("stops before the next folder and returns null once shouldContinue is false", async () => {
  const id = fake.addMessage(account, ["/A", "/B", "/C", "/D"]);
  let allowed = 2;
  const result = await searchLabels({
    headerMessageId: id,
    currentFolderId: null,
    folders: targets(),
    shouldContinue: () => allowed-- > 0,
  });
  assert.equal(result, null, "partial results are discarded");
  assert.equal(fake.world.calls.query.length, 2);
});

test("found: aborts the remaining list with abortList", async () => {
  const id = fake.addMessage(account, ["/A"]);
  await searchLabels({ headerMessageId: id, currentFolderId: null, folders: [account.folder("/A")], shouldContinue: () => true });
  assert.equal(fake.world.calls.abortList.length, 1);
});

test("empty pages with an id are continued until a match", async () => {
  const id = fake.addMessage(account, ["/A"]);
  fake.world.emptyPagesBefore.set(account.folder("/A").id, 3);
  const result = await searchLabels({ headerMessageId: id, currentFolderId: null, folders: [account.folder("/A")], shouldContinue: () => true });
  assert.deepEqual(result, ["A"]);
  assert.equal(fake.world.calls.continueList.length, 3);
  assert.equal(fake.world.calls.abortList.length, 1);
  fake.world.emptyPagesBefore.clear();
});

test("empty pages ending with an id-less empty page mean not contained", async () => {
  const id = fake.addMessage(account, []);
  fake.world.emptyPagesBefore.set(account.folder("/A").id, 2);
  const result = await searchLabels({ headerMessageId: id, currentFolderId: null, folders: [account.folder("/A")], shouldContinue: () => true });
  assert.deepEqual(result, []);
  assert.equal(fake.world.calls.continueList.length, 2);
  assert.equal(fake.world.calls.abortList.length, 0);
  fake.world.emptyPagesBefore.clear();
});

test("a missing or failing abortList is ignored", async (t) => {
  const id = fake.addMessage(account, ["/A", "/B"]);
  const original = fake.browser.messages.abortList;
  t.after(() => {
    fake.browser.messages.abortList = original;
  });
  fake.browser.messages.abortList = undefined;
  assert.deepEqual(
    await searchLabels({ headerMessageId: id, currentFolderId: null, folders: targets(), shouldContinue: () => true }),
    ["A", "B"],
  );
  fake.browser.messages.abortList = () => Promise.reject(new Error("nope"));
  assert.deepEqual(
    await searchLabels({ headerMessageId: id, currentFolderId: null, folders: targets(), shouldContinue: () => true }),
    ["A", "B"],
  );
  fake.browser.messages.abortList = () => {
    throw new Error("sync nope");
  };
  assert.deepEqual(
    await searchLabels({ headerMessageId: id, currentFolderId: null, folders: targets(), shouldContinue: () => true }),
    ["A", "B"],
  );
});

test("a folder whose query throws is logged and skipped", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const id = fake.addMessage(account, ["/B", "/C"]);
  fake.world.failingFolders.add(account.folder("/B").id);
  t.after(() => fake.world.failingFolders.clear());
  const result = await searchLabels({ headerMessageId: id, currentFolderId: null, folders: targets(), shouldContinue: () => true });
  assert.deepEqual(result, ["C"]);
  assert.equal(errors.mock.callCount(), 1);
});

test("no target folders gives an empty result", async () => {
  assert.deepEqual(await searchLabels({ headerMessageId: "<x>", currentFolderId: null, folders: [], shouldContinue: () => true }), []);
});
