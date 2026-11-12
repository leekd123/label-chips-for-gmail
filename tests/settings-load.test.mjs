// Spec 5 step 0, 17.4: requests wait for the one-time settings load.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deferred, installFakeBrowser, settle } from "./helpers/fake-browser.mjs";

const fake = installFakeBrowser();
const storageGate = deferred();
let storageReads = 0;
fake.world.gates.storageGet = () => {
  storageReads++;
  return storageGate.promise;
};
fake.world.storage.settings = { excludeTrash: false, labelCacheMinutes: 5000 };
await import("../extension/src/background/main.js");
const onMessage = fake.browser.runtime.onMessage.listeners[0].fn;

test("getLabels waits for the settings load and then uses the stored values", async () => {
  const account = fake.addAccount();
  const id = fake.addMessage(account, ["/INBOX", "/[Gmail]/Trash"]);
  fake.display(1, account, "/INBOX", id);
  const response = onMessage({ command: "getLabels" }, { tab: { id: 1 } });
  await settle();
  assert.equal(fake.world.calls.getDisplayed.length, 0, "not processed before the load");
  storageGate.resolve();
  const labels = (await response).labels.map((l) => l.path);
  assert.deepEqual(labels, ["INBOX", "[Gmail]/Trash"], "excludeTrash: false from storage");
});

test("settings are read from storage only once", async () => {
  fake.display(2, fake.addAccount(), "/INBOX", "<other@test>");
  await onMessage({ command: "getLabels" }, { tab: { id: 2 } });
  assert.equal(storageReads, 1);
});
