// Spec 11 (registration, already-open tabs) and 12 (startup order).
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeBrowser, settle } from "./helpers/fake-browser.mjs";

const fake = installFakeBrowser();
fake.world.tabs = [
  { id: 1, type: "mail" },
  { id: 2, type: "content" },
  { id: 3, type: "messageDisplay" },
  { id: 4, type: "mail" }, // injection fails (no message displayed)
  { id: 5, type: "mail" },
  { id: 6, type: "addressBook" },
];
fake.world.failingTabs.add(4);
await import("../extension/src/background/main.js");
await settle();

test("registers listeners for messages, tabs, message and folder events, and settings", () => {
  const b = fake.browser;
  assert.equal(b.runtime.onMessage.listeners.length, 1);
  assert.equal(b.tabs.onRemoved.listeners.length, 1);
  for (const name of ["onMoved", "onCopied", "onDeleted", "onNewMailReceived"]) {
    assert.equal(b.messages[name].listeners.length, 1, name);
  }
  for (const name of ["onCreated", "onDeleted", "onRenamed", "onMoved"]) {
    assert.equal(b.folders[name].listeners.length, 1, name);
  }
  assert.equal(b.storage.onChanged.listeners.length, 1);
});

test("registers the message display script once with absolute paths", () => {
  assert.deepEqual(fake.world.calls.register, [
    { js: [{ file: "/src/content/labels.js" }], css: [{ file: "/src/content/labels.css" }] },
  ]);
});

test("injects CSS and JS into already-open mail and messageDisplay tabs only, skipping failures", () => {
  const cssTabs = fake.world.calls.insertCSS.map((c) => c.tabId);
  const jsTabs = fake.world.calls.executeScript.map((c) => c.tabId);
  assert.deepEqual(cssTabs, [1, 3, 4, 5]);
  assert.deepEqual(jsTabs, [1, 3, 5], "tab 4 failed at insertCSS; tab 5 still injected");
  for (const call of fake.world.calls.insertCSS) assert.equal(call.file, "/src/content/labels.css");
  for (const call of fake.world.calls.executeScript) assert.equal(call.file, "/src/content/labels.js");
});
