// Spec 11 (rendering) and 13: the message display script against a minimal fake DOM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../extension/src/content/labels.js", import.meta.url), "utf8");

function createDocument({ existingRows = 0, withBody = true } = {}) {
  const makeElement = (tagName) => {
    const element = {
      tagName: tagName.toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      parent: null,
      append(child) {
        child.parent = element;
        element.children.push(child);
      },
      remove() {
        if (element.parent) {
          const siblings = element.parent.children;
          siblings.splice(siblings.indexOf(element), 1);
          element.parent = null;
        }
      },
    };
    Object.defineProperty(element, "innerHTML", {
      set() {
        throw new Error("innerHTML must not be used");
      },
    });
    return element;
  };
  const body = makeElement("body");
  body.prepend = (child) => {
    child.parent = body;
    body.children.unshift(child);
  };
  body.append(makeElement("p")); // original message content
  const document = {
    body: withBody ? body : null,
    createElement: makeElement,
    querySelectorAll(selector) {
      assert.equal(selector, ".lc-labels");
      return body.children.filter((c) => c.className === "lc-labels");
    },
  };
  for (let i = 0; i < existingRows; i++) {
    const row = makeElement("div");
    row.className = "lc-labels";
    body.prepend(row);
  }
  return { document, body };
}

async function run(document, sendMessage) {
  const sent = [];
  const browser = {
    runtime: {
      sendMessage: (message) => {
        sent.push(message);
        return sendMessage(message);
      },
    },
  };
  const result = vm.runInNewContext(SOURCE, { browser, document, String });
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { result, sent };
}

const rows = (body) => body.children.filter((c) => c.className === "lc-labels");

test("sends getLabels and prepends one chip row with classes and text", async () => {
  const { document, body } = createDocument();
  const { result, sent } = await run(document, async () => ({
    labels: [
      { path: "INBOX", active: true },
      { path: "<b>업무</b>", active: false },
    ],
  }));
  assert.equal(result, undefined, "completion value is clonable for executeScript");
  // The message object comes from another realm (vm context), so compare its JSON form.
  assert.equal(JSON.stringify(sent), JSON.stringify([{ command: "getLabels" }]));
  assert.equal(body.children[0].className, "lc-labels", "row is the first child of body");
  assert.equal(body.children[0].tagName, "DIV");
  const chips = body.children[0].children;
  assert.deepEqual(chips.map((c) => [c.tagName, c.className, c.textContent]), [
    ["SPAN", "lc-label lc-label-active", "INBOX"],
    ["SPAN", "lc-label", "<b>업무</b>"],
  ]);
});

test("existing chip rows are replaced so only one remains", async () => {
  const { document, body } = createDocument({ existingRows: 2 });
  await run(document, async () => ({ labels: [{ path: "INBOX", active: true }] }));
  assert.equal(rows(body).length, 1);
  assert.equal(rows(body)[0].children[0].textContent, "INBOX");
});

test("running twice in the same document leaves a single row", async () => {
  const { document, body } = createDocument();
  const reply = async () => ({ labels: [{ path: "INBOX", active: true }] });
  await run(document, reply);
  await run(document, reply);
  assert.equal(rows(body).length, 1);
});

test("empty or missing labels leave the DOM untouched", async () => {
  for (const reply of [{ labels: [] }, {}, undefined, { labels: "x" }]) {
    const { document, body } = createDocument({ existingRows: 1 });
    const before = [...body.children];
    await run(document, async () => reply);
    assert.deepEqual(body.children, before, JSON.stringify(reply));
  }
});

test("a failed request ends silently", async () => {
  const { document, body } = createDocument();
  const before = [...body.children];
  await run(document, () => Promise.reject(new Error("no receiver")));
  await run(document, () => {
    throw new Error("sync failure");
  });
  assert.deepEqual(body.children, before);
});

test("a document without body is ignored", async () => {
  const { document } = createDocument({ withBody: false });
  await assert.doesNotReject(run(document, async () => ({ labels: [{ path: "INBOX", active: true }] })));
});
