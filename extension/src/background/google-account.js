// Google account detection: [Gmail] folder -> mail domain -> MX lookup (spec 6).

import { TtlLruCache } from "./cache.js";
import { getAccountFolders, hasGmailSystemFolder } from "./folders.js";

const NOT_GOOGLE_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000;
const DNS_TIMEOUT_MS = 2000;
const GOOGLE_MAIL_DOMAINS = ["gmail.com", "googlemail.com"];
const GOOGLE_MX_SUFFIXES = [".google.com", ".googlemail.com"];
const DOH_ENDPOINT = "https://dns.google/resolve";

const resultCache = new TtlLruCache(); // accountId -> boolean
const pending = new Map(); // accountId -> Promise<boolean>

/** @returns {Promise<boolean>} */
export function isGoogleAccount(accountId) {
  const cached = resultCache.get(accountId);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const existing = pending.get(accountId);
  if (existing) {
    return existing;
  }

  const promise = detect(accountId)
    .catch((error) => {
      console.error("Label Chips: Google account detection failed", error);
      return null;
    })
    .then((result) => {
      if (result === true) {
        resultCache.set(accountId, true, Infinity);
      } else if (result === false) {
        resultCache.set(accountId, false, NOT_GOOGLE_TTL_MS);
      } else {
        resultCache.set(accountId, false, RETRY_AFTER_FAILURE_MS);
      }
      return result === true;
    })
    .finally(() => {
      if (pending.get(accountId) === promise) {
        pending.delete(accountId);
      }
    });
  pending.set(accountId, promise);
  return promise;
}

/** @returns {Promise<true|false|null>} null = could not be determined */
async function detect(accountId) {
  try {
    const folders = await getAccountFolders(accountId);
    if (hasGmailSystemFolder(folders)) {
      return true;
    }
  } catch (error) {
    console.error("Label Chips: failed to query folders for account detection", error);
  }

  let account;
  try {
    account = await browser.accounts.get(accountId);
  } catch (error) {
    console.error("Label Chips: accounts.get failed", error);
    return null;
  }
  if (!account) {
    return null;
  }
  if (account.type !== "imap") {
    return false;
  }

  const domains = [
    ...new Set((account.identities ?? []).map((identity) => domainOf(identity?.email)).filter(Boolean)),
  ];
  if (domains.some((domain) => GOOGLE_MAIL_DOMAINS.includes(domain))) {
    return true;
  }

  let undetermined = false;
  for (const domain of domains) {
    const result = await lookupGoogleMx(domain);
    if (result === true) {
      return true;
    }
    if (result === null) {
      undetermined = true;
    }
  }
  return undetermined ? null : false;
}

function domainOf(email) {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

/** @returns {Promise<true|false|null>} */
async function lookupGoogleMx(domain) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DNS_TIMEOUT_MS);
  try {
    const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=MX`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    const answers = Array.isArray(data?.Answer) ? data.Answer : [];
    if (answers.some(isGoogleMxAnswer)) {
      return true;
    }
    return data?.Status === 0 || data?.Status === 3 ? false : null;
  } catch (error) {
    console.error(`Label Chips: MX lookup failed for ${domain}`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isGoogleMxAnswer(answer) {
  if (typeof answer?.data !== "string") return false;
  const tokens = answer.data.trim().split(/\s+/);
  const host = (tokens[tokens.length - 1] ?? "").toLowerCase().replace(/\.$/, "");
  return GOOGLE_MX_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
