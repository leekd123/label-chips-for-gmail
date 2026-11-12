// Spec 6: Google account detection, MX lookup and caching.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { deferred, installFakeBrowser } from "./helpers/fake-browser.mjs";

const fake = installFakeBrowser();
const { isGoogleAccount } = await import("../extension/src/background/google-account.js");

const MINUTE = 60 * 1000;
const PLAIN_FOLDERS = [{ path: "/INBOX", specialUse: ["inbox"] }, { path: "/Sent", specialUse: ["sent"] }];
const mx = (...hosts) => ({ json: { Status: 0, Answer: hosts.map((h) => ({ type: 15, data: h })) } });

let domainCounter = 0;
const newDomain = () => `corp${++domainCounter}.example`;

function mockNow(t) {
  const clock = { now: Date.now() };
  t.mock.method(Date, "now", () => clock.now);
  return clock;
}

beforeEach((t) => {
  for (const list of Object.values(fake.world.calls)) list.length = 0;
  t.mock.method(console, "error", () => {});
});

test("[Gmail] folder means Google without accounts.get or network", async () => {
  const account = fake.addAccount({ emails: ["me@custom.example"] });
  assert.equal(await isGoogleAccount(account.accountId), true);
  assert.equal(fake.world.calls.accountsGet.length, 0);
  assert.equal(fake.world.calls.fetch.length, 0);
});

test("[Google Mail] folder also means Google", async () => {
  const account = fake.addAccount({ emails: ["me@custom.example"], folders: [{ path: "/[Google Mail]/Sent Mail" }] });
  assert.equal(await isGoogleAccount(account.accountId), true);
  assert.equal(fake.world.calls.fetch.length, 0);
});

test("non-IMAP account without [Gmail] folder is not Google", async () => {
  const account = fake.addAccount({ type: "pop3", emails: ["me@gmail.com"], folders: PLAIN_FOLDERS });
  assert.equal(await isGoogleAccount(account.accountId), false);
  assert.equal(fake.world.calls.fetch.length, 0);
});

test("local folders account (type none) is not Google", async () => {
  const account = fake.addAccount({ type: "none", emails: [], folders: PLAIN_FOLDERS });
  assert.equal(await isGoogleAccount(account.accountId), false);
});

test("gmail.com / googlemail.com identity means Google without network", async () => {
  for (const email of ["me@gmail.com", "Me@GoogleMail.COM"]) {
    const account = fake.addAccount({ emails: ["x@other.example", email], folders: PLAIN_FOLDERS });
    assert.equal(await isGoogleAccount(account.accountId), true, email);
  }
  assert.equal(fake.world.calls.fetch.length, 0);
});

test("custom domain with Google MX is Google; DoH URL format", async () => {
  const domain = newDomain();
  fake.world.dns.set(domain, mx("1 smtp.google.com.", "10 alt1.aspmx.l.google.com."));
  const account = fake.addAccount({ emails: [`me@${domain}`], folders: PLAIN_FOLDERS });
  assert.equal(await isGoogleAccount(account.accountId), true);
  assert.deepEqual(fake.world.calls.fetch, [`https://dns.google/resolve?name=${domain}&type=MX`]);
});

test("MX host judgement: last token, case-insensitive, trailing dot, suffix match", async () => {
  const cases = [
    ["10 ASPMX.L.GOOGLE.COM.", true],
    ["  5   alt2.aspmx.l.googlemail.com  ", true],
    ["10 aspmx.l.google.com", true],
    ["10 mail.example.com.", false],
    ["10 google.com.evil.example.", false],
    ["10 notgoogle.com.", false],
    ["10 google.com", false], // must end with ".google.com"
    ["", false],
  ];
  for (const [data, expected] of cases) {
    const domain = newDomain();
    fake.world.dns.set(domain, { json: { Status: 0, Answer: [{ data }] } });
    const account = fake.addAccount({ emails: [`me@${domain}`], folders: PLAIN_FOLDERS });
    assert.equal(await isGoogleAccount(account.accountId), expected, JSON.stringify(data));
  }
});

test("answers without a data string are ignored", async () => {
  const domain = newDomain();
  fake.world.dns.set(domain, { json: { Status: 0, Answer: [{}, { data: 5 }, null] } });
  const account = fake.addAccount({ emails: [`me@${domain}`], folders: PLAIN_FOLDERS });
  assert.equal(await isGoogleAccount(account.accountId), false);
});

test("NOERROR/NXDOMAIN without Google MX: false, cached for 24 hours", async (t) => {
  const clock = mockNow(t);
  for (const status of [0, 3]) {
    const domain = newDomain();
    fake.world.dns.set(domain, { json: { Status: status } });
    const account = fake.addAccount({ emails: [`me@${domain}`], folders: PLAIN_FOLDERS });
    fake.world.calls.fetch.length = 0;
    assert.equal(await isGoogleAccount(account.accountId), false);
    clock.now += 24 * 60 * MINUTE - 1;
    assert.equal(await isGoogleAccount(account.accountId), false);
    assert.equal(fake.world.calls.fetch.length, 1, "still cached just before 24h");
    clock.now += 1;
    await isGoogleAccount(account.accountId);
    assert.equal(fake.world.calls.fetch.length, 2, "looked up again after 24h");
  }
});

test("undetermined results (HTTP error, other Status, exception, timeout) are false for 5 minutes", async (t) => {
  const clock = mockNow(t);
  const failures = [{ ok: false, json: {} }, { json: { Status: 2 } }, new Error("offline")];
  for (const failure of failures) {
    const domain = newDomain();
    fake.world.dns.set(domain, failure);
    const account = fake.addAccount({ emails: [`me@${domain}`], folders: PLAIN_FOLDERS });
    fake.world.calls.fetch.length = 0;
    assert.equal(await isGoogleAccount(account.accountId), false);
    clock.now += 5 * MINUTE - 1;
    await isGoogleAccount(account.accountId);
    assert.equal(fake.world.calls.fetch.length, 1, "no retry within 5 minutes");
    // Recovered network: the retry after 5 minutes can succeed.
    fake.world.dns.set(domain, mx("10 aspmx.l.google.com."));
    clock.now += 1;
    assert.equal(await isGoogleAccount(account.accountId), true);
    assert.equal(fake.world.calls.fetch.length, 2);
  }
});

test("Google result is cached for the whole session", async (t) => {
  const clock = mockNow(t);
  const domain = newDomain();
  fake.world.dns.set(domain, mx("10 aspmx.l.google.com."));
  const account = fake.addAccount({ emails: [`me@${domain}`], folders: PLAIN_FOLDERS });
  assert.equal(await isGoogleAccount(account.accountId), true);
  clock.now += 365 * 24 * 60 * MINUTE;
  assert.equal(await isGoogleAccount(account.accountId), true);
  assert.equal(fake.world.calls.fetch.length, 1);
  assert.equal(fake.world.calls.accountsGet.length, 1);
});

test("MX lookup times out after 2000 ms", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const domain = newDomain();
  fake.world.dns.set(domain, "hang");
  const account = fake.addAccount({ emails: [`me@${domain}`], folders: PLAIN_FOLDERS });
  let settled = false;
  const result = isGoogleAccount(account.accountId).then((value) => {
    settled = true;
    return value;
  });
  for (let i = 0; i < 10 && fake.world.calls.fetch.length === 0; i++) {
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(fake.world.calls.fetch.length, 1);
  t.mock.timers.tick(1999);
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  for (let i = 0; i < 10 && !settled; i++) await new Promise((r) => setImmediate(r));
  assert.equal(settled, true, "aborted exactly at 2000 ms");
  assert.equal(await result, false);
});

test("domains are looked up one by one, in order, and deduplicated", async () => {
  const [d1, d2, d3] = [newDomain(), newDomain(), newDomain()];
  fake.world.dns.set(d1, { json: { Status: 0 } });
  fake.world.dns.set(d2, mx("10 aspmx.l.google.com."));
  fake.world.dns.set(d3, { json: { Status: 0 } });
  const account = fake.addAccount({
    emails: [`a@${d1}`, `b@${d1.toUpperCase()}`, `c@${d2}`, `d@${d3}`],
    folders: PLAIN_FOLDERS,
  });
  assert.equal(await isGoogleAccount(account.accountId), true);
  const looked = fake.world.calls.fetch.map((u) => new URL(u).searchParams.get("name"));
  assert.deepEqual(looked, [d1, d2], "stops at the first Google domain");
});

test("one undetermined domain and no Google domain gives undetermined (retry in 5 min)", async (t) => {
  const clock = mockNow(t);
  const [d1, d2] = [newDomain(), newDomain()];
  fake.world.dns.set(d1, { ok: false, json: {} });
  fake.world.dns.set(d2, { json: { Status: 0 } });
  const account = fake.addAccount({ emails: [`a@${d1}`, `b@${d2}`], folders: PLAIN_FOLDERS });
  assert.equal(await isGoogleAccount(account.accountId), false);
  clock.now += 5 * MINUTE;
  await isGoogleAccount(account.accountId);
  assert.equal(fake.world.calls.fetch.length, 4, "retried after 5 minutes, not 24 hours");
});

test("no identities means not Google, without network", async () => {
  const account = fake.addAccount({ emails: [], folders: PLAIN_FOLDERS });
  assert.equal(await isGoogleAccount(account.accountId), false);
  assert.equal(fake.world.calls.fetch.length, 0);
});

test("concurrent calls for one account share a single detection", async (t) => {
  const gate = deferred();
  fake.world.gates.accountsGet = () => gate.promise;
  t.after(() => {
    fake.world.gates.accountsGet = null;
  });
  const domain = newDomain();
  fake.world.dns.set(domain, mx("10 aspmx.l.google.com."));
  const account = fake.addAccount({ emails: [`me@${domain}`], folders: PLAIN_FOLDERS });
  const calls = [isGoogleAccount(account.accountId), isGoogleAccount(account.accountId), isGoogleAccount(account.accountId)];
  await new Promise((r) => setImmediate(r));
  gate.resolve();
  assert.deepEqual(await Promise.all(calls), [true, true, true]);
  assert.equal(fake.world.calls.accountsGet.length, 1);
  assert.equal(fake.world.calls.fetch.length, 1);
});

test("accounts.get failure or a missing account is undetermined", async (t) => {
  const clock = mockNow(t);
  const missing = "account-does-not-exist";
  assert.equal(await isGoogleAccount(missing), false);
  fake.world.failures.accountsGet = new Error("boom");
  t.after(() => {
    fake.world.failures.accountsGet = null;
  });
  const account = fake.addAccount({ emails: ["me@gmail.com"], folders: PLAIN_FOLDERS });
  assert.equal(await isGoogleAccount(account.accountId), false);
  fake.world.failures.accountsGet = null;
  clock.now += 5 * MINUTE;
  assert.equal(await isGoogleAccount(account.accountId), true, "retried after 5 minutes");
});

test("folders.query failure falls through to the domain check", async (t) => {
  fake.world.failures.foldersQuery = new Error("folders broken");
  t.after(() => {
    fake.world.failures.foldersQuery = null;
  });
  const account = fake.addAccount({ emails: ["me@gmail.com"] });
  assert.equal(await isGoogleAccount(account.accountId), true);
  assert.equal(fake.world.calls.accountsGet.length, 1);
});
