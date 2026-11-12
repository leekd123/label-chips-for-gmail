// Spec 6 step 1, 8.1, 4 (label path): folder filtering and [Gmail] detection.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../extension/src/shared/settings.js";
import { hasGmailSystemFolder, selectLabelFolders, toLabelPath } from "../extension/src/background/folders.js";

const folder = (path, extra = {}) => ({ id: `f:${path}`, path, specialUse: [], ...extra });

const ALL = [
  folder("/", { isRoot: true }),
  folder("/INBOX", { specialUse: ["inbox"] }),
  folder("/[Gmail]/All Mail", { specialUse: ["archives"] }),
  folder("/[Gmail]/Spam", { specialUse: ["junk"] }),
  folder("/[Gmail]/Trash", { specialUse: ["trash"] }),
  folder("/[Gmail]/Sent Mail", { specialUse: ["sent"] }),
  folder("/[Gmail]/Drafts", { specialUse: ["drafts"] }),
  folder("/[Gmail]/Starred", { specialUse: ["flagged"] }),
  folder("/[Gmail]/Important", { specialUse: ["important"] }),
  folder("/업무"),
  folder("/virtual", { isVirtual: true }),
  folder("/tag", { isTag: true }),
  folder("/unified", { isUnified: true }),
  { path: "/no-id", specialUse: [] },
];

const paths = (folders) => folders.map((f) => f.path);

test("default settings exclude archives, junk and trash, and keep folder order", () => {
  assert.deepEqual(paths(selectLabelFolders(ALL, DEFAULT_SETTINGS)), [
    "/INBOX",
    "/[Gmail]/Sent Mail",
    "/[Gmail]/Drafts",
    "/[Gmail]/Starred",
    "/[Gmail]/Important",
    "/업무",
  ]);
});

test("root, virtual, tag, unified and id-less folders are never searched", () => {
  const all = selectLabelFolders(ALL, { excludeArchives: false, excludeJunk: false, excludeTrash: false });
  for (const p of ["/", "/virtual", "/tag", "/unified", "/no-id"]) {
    assert.ok(!paths(all).includes(p), p);
  }
});

test("each exclusion setting controls only its own special use", () => {
  const cases = [
    ["excludeArchives", "/[Gmail]/All Mail"],
    ["excludeJunk", "/[Gmail]/Spam"],
    ["excludeTrash", "/[Gmail]/Trash"],
  ];
  for (const [key, path] of cases) {
    const settings = { ...DEFAULT_SETTINGS, [key]: false };
    const result = paths(selectLabelFolders(ALL, settings));
    assert.ok(result.includes(path), `${key} off -> ${path} included`);
    for (const [otherKey, otherPath] of cases) {
      if (otherKey !== key) assert.ok(!result.includes(otherPath), `${otherKey} still on`);
    }
  }
});

test("a folder with several special uses is excluded if any is excluded", () => {
  const f = folder("/both", { specialUse: ["sent", "trash"] });
  assert.deepEqual(selectLabelFolders([f], DEFAULT_SETTINGS), []);
});

test("missing specialUse is treated as none", () => {
  const f = { id: "x", path: "/x" };
  assert.deepEqual(paths(selectLabelFolders([f], DEFAULT_SETTINGS)), ["/x"]);
});

test("[Gmail] / [Google Mail] top-level folder detection", () => {
  const yes = ["/[Gmail]", "/[Gmail]/Sent Mail", "/[Google Mail]", "/[Google Mail]/All Mail"];
  const no = ["/[Gmail]x", "/INBOX/[Gmail]", "/Gmail", "[Gmail]/Sent", "/[gmail]", "/[Google Mail"];
  for (const p of yes) assert.ok(hasGmailSystemFolder([folder("/INBOX"), folder(p)]), p);
  for (const p of no) assert.ok(!hasGmailSystemFolder([folder(p)]), p);
  assert.ok(!hasGmailSystemFolder([]));
});

test("label path strips exactly one leading slash", () => {
  assert.equal(toLabelPath("/INBOX"), "INBOX");
  assert.equal(toLabelPath("/[Gmail]/Sent Mail"), "[Gmail]/Sent Mail");
  assert.equal(toLabelPath("/업무/프로젝트A"), "업무/프로젝트A");
  assert.equal(toLabelPath("//double"), "/double");
  assert.equal(toLabelPath("noslash"), "noslash");
  assert.equal(toLabelPath(undefined), "");
});
