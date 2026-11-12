// Spec 17.4: a failed settings load is logged and defaults are used.
import assert from "node:assert/strict";
import { test } from "node:test";
import { installFakeBrowser } from "./helpers/fake-browser.mjs";

const fake = installFakeBrowser();
fake.world.failures.storageGet = new Error("storage broken");
const errors = [];
const originalError = console.error;
console.error = (...args) => errors.push(args);
await import("../extension/src/background/main.js");
const onMessage = fake.browser.runtime.onMessage.listeners[0].fn;

test("requests still work with default settings", async (t) => {
  t.after(() => {
    console.error = originalError;
  });
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/업무", "/[Gmail]/Trash"]);
  fake.display(1, account, "/INBOX", id);
  const response = await onMessage({ command: "getLabels" }, { tab: { id: 1 } });
  assert.deepEqual(response.labels.map((l) => l.path), ["INBOX", "업무"]);
  assert.ok(errors.some(([message]) => String(message).includes("settings")));
});
