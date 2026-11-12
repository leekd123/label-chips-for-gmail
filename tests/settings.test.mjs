// Spec 17.1, 17.3: settings defaults and validation (shared module).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  isValidSetting,
  normalizeSettings,
  parseLabelCacheMinutes,
} from "../extension/src/shared/settings.js";

test("defaults match spec 17.1", () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS }, {
    excludeArchives: true,
    excludeJunk: true,
    excludeTrash: true,
    labelCacheMinutes: 30,
  });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
});

test("missing or non-object stored value gives all defaults", () => {
  for (const raw of [undefined, null, 42, "x", [], [true]]) {
    assert.deepEqual(normalizeSettings(raw), { ...DEFAULT_SETTINGS }, String(raw));
  }
});

test("invalid items fall back individually; valid items are kept; unknown keys dropped", () => {
  const result = normalizeSettings({
    excludeArchives: false,
    excludeJunk: "no",
    excludeTrash: 0,
    labelCacheMinutes: 60,
    somethingElse: 1,
  });
  assert.deepEqual(result, {
    excludeArchives: false,
    excludeJunk: true,
    excludeTrash: true,
    labelCacheMinutes: 60,
  });
});

test("labelCacheMinutes must be an integer in 1..1440", () => {
  for (const ok of [1, 30, 1440]) assert.ok(isValidSetting("labelCacheMinutes", ok), String(ok));
  for (const bad of [0, 1441, -5, 1.5, "30", NaN, Infinity, null]) {
    assert.ok(!isValidSetting("labelCacheMinutes", bad), String(bad));
    assert.equal(normalizeSettings({ labelCacheMinutes: bad }).labelCacheMinutes, 30);
  }
});

test("unknown setting key is never valid", () => {
  assert.ok(!isValidSetting("other", true));
});

test("normalize does not read inherited properties", () => {
  const raw = Object.create({ excludeTrash: false });
  assert.equal(normalizeSettings(raw).excludeTrash, true);
});

test("parseLabelCacheMinutes accepts plain integers in range only", () => {
  assert.equal(parseLabelCacheMinutes("1"), 1);
  assert.equal(parseLabelCacheMinutes(" 1440 "), 1440);
  assert.equal(parseLabelCacheMinutes("007"), 7);
  for (const bad of ["", "0", "1441", "1.5", "1e2", "-3", "+3", "abc", null, undefined]) {
    assert.equal(parseLabelCacheMinutes(bad), null, String(bad));
  }
});
