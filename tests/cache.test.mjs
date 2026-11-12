// Spec 9.1: TTL + LRU cache.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TtlLruCache } from "../extension/src/background/cache.js";

function mockNow(t, start = 1_000_000) {
  const clock = { now: start };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

test("get returns undefined for a missing key", () => {
  assert.equal(new TtlLruCache().get("x"), undefined);
});

test("stores falsy values such as an empty array and false", () => {
  const cache = new TtlLruCache();
  cache.set("a", []);
  cache.set("b", false);
  assert.deepEqual(cache.get("a"), []);
  assert.equal(cache.get("b"), false);
});

test("entry expires when now >= expiresAt", (t) => {
  const clock = mockNow(t);
  const cache = new TtlLruCache({ ttl: 1000 });
  cache.set("a", 1);
  clock.now += 999;
  assert.equal(cache.get("a"), 1);
  clock.now += 1;
  assert.equal(cache.get("a"), undefined);
});

test("get does not extend the expiry time", (t) => {
  const clock = mockNow(t);
  const cache = new TtlLruCache({ ttl: 1000 });
  cache.set("a", 1);
  for (let i = 0; i < 9; i++) {
    clock.now += 100;
    assert.equal(cache.get("a"), 1);
  }
  clock.now += 100;
  assert.equal(cache.get("a"), undefined);
});

test("per-entry TTL overrides the default", (t) => {
  const clock = mockNow(t);
  const cache = new TtlLruCache({ ttl: 10_000 });
  cache.set("short", 1, 100);
  cache.set("long", 2);
  clock.now += 100;
  assert.equal(cache.get("short"), undefined);
  assert.equal(cache.get("long"), 2);
});

test("default TTL is infinite", (t) => {
  const clock = mockNow(t);
  const cache = new TtlLruCache();
  cache.set("a", 1);
  clock.now += 365 * 24 * 3600 * 1000;
  assert.equal(cache.get("a"), 1);
});

test("evicts the least recently used entry at max size", () => {
  const cache = new TtlLruCache({ maxSize: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.get("a"); // a becomes most recently used
  cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.get("c"), 3);
});

test("re-setting an existing key does not evict another entry", () => {
  const cache = new TtlLruCache({ maxSize: 2 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 10);
  assert.equal(cache.get("a"), 10);
  assert.equal(cache.get("b"), 2);
});

test("delete and clear", () => {
  const cache = new TtlLruCache();
  cache.set("a", 1);
  cache.set("b", 2);
  cache.delete("a");
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("b"), 2);
  cache.clear();
  assert.equal(cache.get("b"), undefined);
});
