# Label Chips for Gmail (Thunderbird extension) — Requirements Specification

[한국어](REQUIREMENTS.ko.md) | **English**

Target version: 0.1.0
This document specifies the extension so it can be implemented from scratch. It describes both the behavior users observe and the internal rules needed to guarantee that behavior.
`[Required]` marks items that must be followed; `[Free]` marks items left to the implementer. Behavior rules without a mark are treated as `[Required]`.

---

## 1. Product overview

- When a message from a Gmail/Google Workspace **IMAP** account is opened, the Gmail labels of that message are shown as chips at the very top of the message body.
- Gmail labels appear as folders in Thunderbird. The extension therefore finds "the folders that contain a message with the same `Message-ID`" and shows those folder paths as labels.
- Nothing is shown for accounts that are not Google accounts.
- Some behavior can be changed on the options page (section 17). There is no other UI, such as toolbar buttons.

## 2. Packaging / manifest

| Item | Value |
|---|---|
| `manifest_version` | `2` |
| `name` | `Label Chips for Gmail` |
| `description` | `Shows Gmail labels at the top of each message` |
| `author` | `leekd123` |
| `version` | `0.1.0` |
| `browser_specific_settings.gecko.id` | `label-chips-for-gmail@leekd123` (must not change after the first release — changing it makes it a different extension) |
| `browser_specific_settings.gecko.strict_min_version` | `121.0` (uses `folders.query`, `MailFolder.id`, and `folderId` in `messages.query`; `messagesPerPage` is TB 120+) |
| `icons` | `images/icon-32.png`, `icon-48.png`, `icon-64.png` (32/48/64 px PNG, newly made) |
| `background` | `{ "page": "src/background.html" }` — a **background page** rather than a script list, so that ES modules can be used |
| `options_ui` | `{ "page": "src/options/options.html" }` — shown in the extension's options tab in the Add-ons Manager |
| `permissions` | `messagesModify`, `messagesRead`, `accountsRead`, `storage`, `*://dns.google/*` |

What each permission is for:

- `messagesModify`: `messageDisplayScripts.register`, and `tabs.executeScript/insertCSS` on already-open message tabs (injecting the script/CSS into the message display document)
- `messagesRead`: `messageDisplay.getDisplayedMessage`, `messages.query/continueList/abortList`, `messages.onMoved/onCopied/onDeleted/onNewMailReceived`
- `accountsRead`: `accounts.get`, `folders.query`, `folders.on*`
- `*://dns.google/*`: DNS-over-HTTPS calls from the background page

- `storage`: storing user settings (`storage.local`) and detecting changes (`storage.onChanged`). No data other than settings is stored.

No other permissions are needed.

Project structure:

```
label-chips/                 repository root
  extension/                 extension source (the contents of this folder become the xpi as-is)
    manifest.json
    images/
    src/
      background.html        background page (loads ES modules)
      background/            background modules
      content/               message display script and CSS
      options/               options page (HTML/JS/CSS)
  docs/REQUIREMENTS.md
  deploy.ps1
  README.md
```

Build (`deploy.ps1`, PowerShell): zip the **contents** of `extension/` (not the folder itself; `manifest.json` is at the archive root) and save it as `.deploy/label-chips-<manifest.version>.xpi`. Paths are resolved relative to the script location (`$PSScriptRoot`) so it works from any working directory; `.deploy` is created if missing, and an existing file with the same name is overwritten. The version is read from `manifest.json`. `.deploy/` is listed in gitignore.

## 3. Components

```
Background page (persistent; all state in memory)
 ├─ Request handler      : handles getLabels requests from the content script, per-tab state
 ├─ Label service        : label cache, sharing of in-flight searches, invalidation
 ├─ Label search         : queries label folders one at a time
 ├─ Label folder list    : account folder cache, search target filter, [Gmail] folder detection
 ├─ Google account check : [Gmail] folder → mail domain → MX lookup
 ├─ Settings             : loads and validates stored settings, detects changes
 └─ TTL/LRU cache
Message display script (injected every time a message is displayed)
 └─ getLabels request → renders the response into the DOM
Options page (options_ui)
 └─ shows and saves settings
```

How modules are split is `[Free]`. The behavior rules below are `[Required]`.

## 4. Message protocol (content ↔ background)

- Request: `browser.runtime.sendMessage({ command: "getLabels" })`. No arguments. The background decides which message it is about from `sender.tab.id`.
- Response: `{ labels: Array<{ path: string, active: boolean }> }`
  - `path`: the folder path with its single leading `/` removed (e.g. `INBOX`, `[Gmail]/Sent Mail`, `Work/ProjectA`). The raw `MailFolder.path`, not a localized name.
  - `active`: `true` if this is the folder of the currently displayed message.
- "Nothing to show" is always `{ labels: [] }`.
- The `onMessage` listener returns `undefined` when `message?.command !== "getLabels"` (leaving it to other listeners), and otherwise **returns a Promise**. Exceptions during processing are logged with `console.error` and answered with `{ labels: [] }` (no rejection reaches the caller).

## 5. Request flow (`getLabels`)

Per-tab state `tabStates: Map<tabId, { requestId: number, displayedKey: string|null }>`.

0. Wait until settings have finished loading (17.4). Loading happens only once at startup, so later requests pass through without delay.
1. If `tabId` is `undefined`/`null`, return `{labels: []}`.
2. If there is no state for the tab, create `{requestId: 0, displayedKey: null}`. Increment `requestId` by 1 and remember it as this request's number.
   - **Stale check**: `tabStates.get(tabId)?.requestId !== my number` (a new request arrived for the same tab, or the tab was closed).
3. Call `messageDisplay.getDisplayedMessage(tabId)`. If stale afterwards, return `{labels: []}`.
4. If `messageHeader.folder.accountId` or `messageHeader.headerMessageId` is missing, set `displayedKey = null` and return `{labels: []}`. (e.g. .eml files, messages without a folder)
5. `key = "${accountId}_${headerMessageId}"`, `currentPath = label path of the current folder`. Record `displayedKey = key`.
   - `messageHeader.id` must not be used in the key. Each folder copy has a different id, so the cache could not be shared.
6. If the label cache has `key` (including an empty array), build the response immediately (section 7) **without the Google account check**.
7. If `isGoogleAccount(accountId)` is `false`, or the request is stale after the check, return `{labels: []}`.
8. Run the label search (section 8). The continue condition is "`key` is still the `displayedKey` of **any tab**".
9. If stale, return `{labels: []}`. If the search result is `null` (aborted) but the request is not stale — this is the case of moving to another message and back, joining a search that had already decided to abort — run step 8 again **once only**. If that result is also `null`, or the request is stale afterwards, return `{labels: []}`; otherwise build the response.

On `tabs.onRemoved`, delete the state for that `tabId`.

## 6. Google account detection

`isGoogleAccount(accountId): Promise<boolean>`

Order of checks (result is `true` / `false` / `null` = undetermined):

1. If the account's folder list (the cached list from section 9) contains any folder whose path matches the regular expression `^\/\[(Gmail|Google Mail)\](\/|$)`, return `true`. No network lookup. If the folder query fails, only log it and go to the next step.
2. `accounts.get(accountId)`. If it fails or there is no account, `null`.
3. If `account.type !== "imap"`, `false`.
4. Collect the lowercase domain after `@` from the `email` of every identity of the account (deduplicated). If `gmail.com` or `googlemail.com` is among them, `true`.
5. Look up MX for the remaining domains **one by one, in order**. If any is Google, return `true` immediately. If every domain is definitely not Google, `false`; if any was undetermined, `null`. (No domains → `false`.)

MX lookup:

- `GET https://dns.google/resolve?name=<encodeURIComponent(domain)>&type=MX`
- Timeout 2000 ms (abort with `AbortController`; always clear the timer)
- If the HTTP response is not ok, `null`. On exception/timeout, log and return `null`.
- `true` if any entry in `Answer[]` is a Google MX.
  - Check: take `answer.data` (e.g. `"10 aspmx.l.google.com."`), trim → split on whitespace and take the **last token** → lowercase → remove a trailing `.` → does it end with `.google.com` or `.googlemail.com`? (No value → `false`.)
- Otherwise `false` if `Status` is `0` (NOERROR) or `3` (NXDOMAIN), and `null` for any other value.

Caching (in memory, per accountId):

| Result | Cached value | Lifetime |
|---|---|---|
| `true` | `true` | Indefinitely (for the session) |
| `false` | `false` | 24 hours |
| `null` | `false` | 5 minutes (retried afterwards) |

- While a check for the same account is in progress, **share the same Promise** (no duplicate lookups). When it finishes, remove it from the in-progress list whether it succeeded or failed.

## 7. Building the response

Input: list of label paths `paths`, current folder path `currentPath`.

- If `currentPath` is not empty: `[currentPath, ...the rest of paths without currentPath (original order kept)]`
- If it is empty: `paths` as-is
- For each item, `active = (path === currentPath)`

As a result:

- The current folder is **always first** and shown in grey (active), even if it is an excluded folder (Trash/Spam/All Mail).
- The order of the rest is the folder order returned by `folders.query`.
- The cache stores only the "list of paths"; `active` is recomputed on every request (because several copies of the same message share the cache).
- A message in a Google account always shows at least the current folder chip, even without other labels.

## 8. Label search

### 8.1 Folders to search

Folders of the account that satisfy **all** of the following:

- `folder.id` is present
- none of `isRoot`, `isVirtual`, `isTag`, `isUnified`
- `specialUse` contains no **excluded** value. The excluded values are those turned on in the settings (section 17); by default all of `archives`, `junk` and `trash`.
  - `archives` = Gmail All Mail (`[Gmail]/All Mail`). It contains every message, so it is the most expensive to scan and is excluded by default.
  - Inbox, Sent, Drafts, Starred, Important, etc. are **included**.

### 8.2 Query conditions

- `headerMessageId`: the `headerMessageId` of the displayed message
- `folderId`: the id of the target folder — **never query the whole account; always one folder at a time**
- `messagesPerPage: 1` — so that the first page is returned as soon as the first match is found. With the default (100), a folder with only one match returns only after the scan finishes or one second passes, and early termination (8.3) does not work.
- No date conditions (`fromDate`/`toDate`). `messages.query` walks every header in the folder and compares the conditions one by one, so a date condition does not reduce the amount scanned; and copies with the same `Message-ID` also have the same date, so the result is unaffected.

### 8.3 Procedure

Walk the target folders in order:

1. If the folder is the current folder (`folder.id === messageHeader.folder.id`), add it to the result without a query and move on. (No yield and no abort check either.)
2. If the loop index is greater than 0, **yield to the event loop** with `setTimeout(0)`.
3. Check the continue condition. If `false`, abort the whole search and return `null` (partial results are discarded).
4. Run `messages.query({...conditions, folderId})`.
   - If the result page has one or more messages, the folder "contains" the message. If `page.id` is present, call `messages.abortList(page.id)` to stop the rest of the list (ignore a missing API or a failure; do not wait for it).
   - If there are no messages and `page.id` is present, fetch the next page with `messages.continueList(page.id)` and **repeat** the same check. A page with messages means "contains" (with `abortList` as above); an empty page without `page.id` means "does not contain".
5. If the query for a folder throws, log it with `console.error`, skip only that folder and continue.

Returns: the label paths of the folders that contain the message (in folder order), or `null` if aborted.

### 8.4 Limits of the search

`messages.query` searches only the **local folder data Thunderbird has already synchronized**, not the Gmail server. Copies in label folders that have not been synchronized yet are not found. This limit is mitigated by the new-mail invalidation in 9.3 and the recommended Thunderbird setting in section 16 (checking all folders for new mail).

## 9. Caches

All caches are **memory only** and are reset when Thunderbird restarts. Persistent storage (`storage.local`) holds only user settings.

### 9.1 Common cache behavior (TTL + LRU)

- Creation options: default TTL (default: infinite), maximum size (default: unlimited). A per-entry TTL can be given to `set`.
- `get`: `undefined` if missing. If expired (`now >= expiresAt`), delete it and return `undefined`. If valid, **only update the LRU order** and return the value — **the expiry time is not extended**.
- `set`: first delete the same key; if the size is at or above the maximum, evict the least recently used entries, then store. `expiresAt = now + ttl`.
- Provides `delete` and `clear`.

### 9.2 Cache list

| Cache | Key | Value | TTL | Max entries |
|---|---|---|---|---|
| Labels | `accountId_headerMessageId` | label paths `string[]` | setting (default 30 min) | 1000 (LRU) |
| Folder list | `accountId` | full result of `folders.query({accountId})` | 10 min | unlimited |
| Google account | `accountId` | `boolean` | table in section 6 | unlimited |

- The folder list cache stores the unfiltered original, shared by the label folder filter and `[Gmail]` detection.
- The label cache stores **only completed search results**. Aborted searches (`null`) and results of invalidated searches are not stored.

### 9.3 Invalidation

Adding, removing or moving a label in Gmail appears in Thunderbird as copying, moving or deleting between folders.

| Event | Action |
|---|---|
| `messages.onMoved(original, moved)` | Per-message invalidation for every message in both lists |
| `messages.onCopied(original, copied)` | Per-message invalidation for every message in both lists |
| `messages.onDeleted(list)` | Per-message invalidation for every message in the list |
| `messages.onNewMailReceived(folder, messages)` — registered with `addListener(listener, true)` | Per-message invalidation for every message in `messages` |
| `folders.onCreated / onDeleted / onRenamed / onMoved` | Clear the whole folder list cache + clear the whole label cache + mark all in-flight searches as cancelled |
| User settings change (`storage.onChanged`) | Clear the whole label cache + mark all in-flight searches as cancelled (17.4) |

- Message lists may be paginated. While `page.id` is present, walk to the end with `messages.continueList`. Exceptions while walking are only logged. Listeners do not wait for this work.
- **Per-message invalidation** (`accountId` = `message.folder?.accountId`, `headerMessageId`; ignore the message if either is missing):
  1. Delete that key from the label cache
  2. If a search for that key is in progress, mark it "cancelled" and remove it from the in-progress list
- Cancelled searches are **not forcibly stopped**. They keep running and return their result to the requests already waiting on them, but **do not write to the cache**. Later requests for the same message start a new search.
- Why `onNewMailReceived` is needed: a label applied by a Gmail filter on the server shows up as "new mail" in that label folder when Thunderbird synchronizes the folder. If the message was opened before that, a "no labels" result is cached; it must be removed on this event so that the next open searches again.
  - Register with the second argument `monitorAllFolders = true` (TB 121+) to watch special folders such as Sent, not just the Inbox and normal folders.
  - The extension does not force folder synchronization (there is no API for it). Synchronization itself depends on Thunderbird's settings (section 16).
- Folder event listeners are skipped if the event does not exist in the API.
- Labels already drawn on screen are not refreshed. Changes appear when the message is displayed again.

## 10. Asynchronous processing / preventing UI freezes **[Core]**

Background: `messages.query` walks the target folder's messages on Thunderbird's **main thread**. Querying the whole account or a large folder at once freezes the UI. The extension cannot move the query itself to another thread, so the rules below reduce "the size of each unit of work" and "the amount of unnecessary work". All are `[Required]`.

1. **Split by folder**: always query one folder at a time with `folderId`, **sequentially** (no concurrent queries — parallelizing with `Promise.all` piles work onto the main thread).
2. **Yield between folders**: between folder queries, create a macrotask boundary with `setTimeout(0)` so UI events can be processed. (A microtask yield such as `await Promise.resolve()` has no effect.)
3. **Exclude the most expensive folders**: with the default settings, All Mail (`archives`), Spam and Trash are not queried. If the user turns an exclusion off, that folder becomes a query target, so the options page shows a performance warning (17.2).
4. **Do not query the current folder**: we already know the message is there.
5. **Early termination**: query with `messagesPerPage: 1` so the result arrives as soon as one match is found in a folder, and stop the rest of the scan with `abortList`.
6. **Per-folder cancellation**: right before each folder query, check "is this message still displayed in any tab?"; if not, give up all remaining folder queries. This prevents scans from piling up when moving quickly through messages.
   - If tab A moves on but tab B still displays the same message, continue.
   - When going A → B → A, keep sharing A's search as long as it is alive.
7. **Share in-flight searches**: if a search for the same key is in progress, share its Promise instead of starting a new one. When a search ends (success, abort or exception), remove it from the in-progress list — but do not remove a different search that was registered under the same key after an invalidation.
8. **Discard stale responses**: after every `await` (displayed message lookup, account check, search), check the tab's `requestId`; if this is not the latest request, finish with `{labels: []}`. Only when the latest request receives an aborted result (`null`) is the search started again, once (section 5 step 9).
9. **Cache first**: on a cache hit, respond immediately without the account check or a search.
10. **Network limits**: MX lookup has a 2-second timeout, is shared once per account, and is not retried for 5 minutes after a failure. Typical Gmail accounts with a `[Gmail]` folder make no network lookup at all.
11. **Non-blocking rendering**: the content script does not block message display while waiting for the response. The message body appears first and the labels are inserted when the response arrives.
12. **Non-blocking event listeners**: invalidation listeners and script registration at startup run without being awaited; failures are only logged.

Known limitation (accepted in 0.1.0): `messages.query` walks every header in a folder without an index, and a single folder query cannot be split, so a label folder with a very large number of messages can cause a brief stutter while it is queried.

## 11. Message display script (UI)

- Registration: once at background startup with `messageDisplayScripts.register({ js: [...], css: [...] })`. It is injected into the message body document every time a message is displayed (3-pane preview, message tab, separate window).
- Messages already open: `messageDisplayScripts` applies only to messages displayed **after** registration. So that chips also appear on messages already displayed right after the extension is installed, updated or re-enabled, collect tabs once with `tabs.query({})` right after registration, and inject the same CSS and JS with `tabs.insertCSS` / `tabs.executeScript` into every tab whose `type` is `mail` or `messageDisplay`.
  - An injection failure for one tab (e.g. a tab with no displayed message) is ignored and the next tab is processed. This work is not awaited.
  - To verify during implementation: check in a real Thunderbird that `tabs.executeScript` on mail tabs works with only the `messagesModify` permission. If it does not, do not implement this item and list it in the README as a known limitation (do not add permissions).
- Behavior:
  1. Send `{command: "getLabels"}`. On failure, end silently.
  2. If `labels` is missing or empty, end without touching the DOM.
  3. Inside `<div class="lc-labels">`, create a `<span class="lc-label">` for each label (`lc-label lc-label-active` if active), and set the text with `textContent = path` (no HTML insertion).
  4. If the document already has `.lc-labels` elements, remove them all (prevents duplicates when the script is injected twice into the same document).
  5. `document.body.prepend(container)` — at the very start of the body.
- Styles:

| Selector | Style |
|---|---|
| `.lc-labels` | `background-color: Canvas` (system color that follows light/dark automatically), `padding: 0.5rem`, `display: flex`, `flex-wrap: wrap`, `gap: 6px 10px`, `position: sticky; top: 0`, `z-index: 1000` |
| `.lc-label` | `background: rgb(155, 157, 226)`, `border-radius: 5px`, `padding: 2px 6px`, `color: white`, `font-size: 14px`, `font-family: "Open Sans", system-ui, sans-serif` |
| `.lc-label-active` | `background: rgb(131, 131, 131)` |

  - The label row stays fixed at the top of the body while scrolling.
  - The class prefix `lc-` avoids conflicts with the message body's CSS.
- Label chips are display-only. They have no click behavior.

## 12. Startup (background load order)

1. Register listeners: `runtime.onMessage`, `tabs.onRemoved`, `messages.onMoved/onCopied/onDeleted/onNewMailReceived`, `folders.on*`
2. Start loading settings (not awaited, 17.4) and register the `storage.onChanged` listener
3. `messageDisplayScripts.register(...)`. Failures are only logged.
4. Inject the script/CSS into already-open message tabs (section 11). Not awaited.

## 13. Error handling principles

- No error is ever shown to the user. The background only logs with `console.error`, and the outcome falls back to "no labels" or "skip that folder".
- The content script ends without logging errors.

## 14. Non-functional requirements

- No external libraries, build tools or bundlers. Plain JS (ES modules) + CSS.
- The only external communication is the MX lookup at `dns.google`, and the only data sent is the **domain** of the account's mail address (nothing is sent for `gmail.com`/`googlemail.com` or when a `[Gmail]` folder exists).
- The only persisted data is user settings. Messages, folders and account information are not stored.
- Messages and folders are never modified (read-only behavior).

## 15. Acceptance test scenarios

| # | Situation | Expected result |
|---|---|---|
| 1 | Gmail IMAP account, open a message in INBOX (has the label `Work`) | `INBOX` (grey) then `Work` (purple) shown at the top of the body |
| 2 | Open the same message from the `Work` folder | `Work` (grey) first, then `INBOX` (purple). Cache used, no new search |
| 3 | Message without labels | Only the current folder chip |
| 4 | Open a message in Trash/Spam/All Mail | Current folder shown first in grey. These folders do not appear in other messages' label lists |
| 5 | Non-Google IMAP account, POP3 account, Local Folders | Nothing shown |
| 6 | Custom-domain Workspace account without a `[Gmail]` folder | Labels shown after the MX lookup |
| 7 | Account from #6 while offline / DNS failing | Nothing shown. Retried when opened again after 5 minutes |
| 8 | Moving quickly through messages with the arrow keys in an account with many folders | UI does not freeze. Searches for skipped messages are aborted and only the last message's labels are shown |
| 9 | Copy/move/delete a message to another folder, then open it again | Changed labels are reflected (without waiting for the 30-minute cache) |
| 10 | Create/delete/rename a folder, then open a message | Searched again based on the new folder structure |
| 11 | Open the same message in two tabs at once | The search runs only once and both tabs show the labels |
| 12 | Close the tab during a search | Remaining folder queries are aborted unless another tab displays the message |
| 13 | Dark mode | Label row background follows the message document's color scheme |
| 14 | Scrolling a long message | Label row stays fixed at the top |
| 15 | Open a message after restarting Thunderbird | Searched from scratch without cache and shown |
| 16 | Run `deploy.ps1` from another directory | `.deploy/label-chips-<version>.xpi` created and installable |
| 17 | Open a new message labeled by a Gmail filter right away from the Inbox (check-all-folders setting **off**) | Only the current folder chip (label folder not synchronized — expected behavior) |
| 18 | Right after #17, click the label folder to synchronize it, then open the message again | Labels shown without waiting 30 minutes or restarting |
| 19 | With the check-all-folders setting **on**, receive a new message labeled by a filter and open it | Labels shown. If opened before the label folder synchronized, shown when opened again |
| 20 | Settings never changed | Everything runs with the defaults (three folders excluded, 30-minute cache) |
| 21 | Turn off "Exclude Trash" in the settings, then open from another folder a message that also has a copy in Trash | The Trash path is shown as a label without restarting |
| 22 | Install (or disable and re-enable) the extension while a message is open | Chips appear without reopening the message. Only one chip row is created |
| 23 | Enter an out-of-range value on the options page | Not saved; an error is shown. The previous value stays in effect |
| 24 | Run "Restore defaults" | Every item is saved as its default and takes effect immediately |
| 25 | Restart Thunderbird | Changed settings are kept |
| 26 | Quickly go back from message A → B → A before the search finishes | A's labels are shown (not left empty) |

## 16. User manual requirements

`README.md` contains "Usage" and "Troubleshooting" sections with the content below. The wording may be polished, but no item or procedure may be omitted.

### 16.1 How it works (one paragraph)

- The extension does not ask the Gmail server; it finds the same message in the folders Thunderbird has downloaded and shows them as labels.
- Therefore **labels whose folders Thunderbird has not synchronized yet are not shown.**
- All Mail, Spam and Trash are not shown as labels (they are shown only when they are the folder currently opened).

### 16.2 Recommended setting: check all folders for new mail

By default Thunderbird checks only the Inbox for new mail. To make labels applied automatically by Gmail filters appear on new messages right away, set one of the following.

Option A — all folders (recommended):

1. Open the **Config Editor** at the bottom of Thunderbird **Settings → General**.
2. Search for `mail.server.default.check_all_folders_for_new`.
3. Change the value to `true`.
4. Restart Thunderbird.

Option B — selected label folders only:

1. In the folder pane, right-click the label folder → **Properties**.
2. Turn on **When getting new messages for this account, always check this folder** (Korean UI: *새 메시지를 받을 때 항상 이 폴더 확인*).
3. Repeat for each label folder needed.

Point to mention: Option A can make checking for new mail take longer on accounts with many folders.

### 16.3 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A new message shows only the current folder label, not the labels applied by filters | Label folders not synchronized yet | Apply 16.2. For now, click the label folder once and open the message again |
| A label just added in Gmail on the web is not shown | Same as above (server change not synchronized yet) | Same as above |
| No labels shown at all | Not recognized as a Google account (POP3 account, non-IMAP account, failed domain MX lookup) | Check that it is an IMAP account. If it was a network problem, open the message again after 5 minutes |
| All Mail/Spam/Trash not shown as labels | Excluded by default | Turn off the exclusion in the settings if needed (All Mail can be slow) |
| Labels of the open message do not change | Labels already shown are not refreshed | Select another message, then open it again |

### 16.4 Settings guide

The README covers how to open the options page (Add-ons Manager → Extensions → Options) and, for each item in 17.1, its description, default and caveats.

## 17. User settings

### 17.1 Settings

| Key | Name on screen | Type | Default | Allowed range | Affects |
|---|---|---|---|---|---|
| `excludeArchives` | 전체보관함 제외 (Exclude All Mail) | Boolean | `true` | — | 8.1 |
| `excludeJunk` | 스팸 제외 (Exclude Spam) | Boolean | `true` | — | 8.1 |
| `excludeTrash` | 휴지통 제외 (Exclude Trash) | Boolean | `true` | — | 8.1 |
| `labelCacheMinutes` | 라벨 캐시 유지 시간 (분) (Label cache lifetime, minutes) | Integer | `30` | `1`–`1440` | 9.2 |

Values not in this table (the fixed constants in section 18) cannot be changed by the user.

### 17.2 Options page

- Provided through `options_ui` in the manifest. Built with HTML/JS/CSS, no framework.
- Layout:
  - "검색" (Search) section: three checkboxes for excluded folders
  - "캐시" (Cache) section: label cache lifetime (number input)
  - "기본값으로 되돌리기" (Restore defaults) button
- Each item has a one-line description below it. The following item shows a warning:
  - Exclude All Mail: "끄면 메일을 열 때마다 전체보관함을 검색하므로 Thunderbird가 느려지거나 잠시 멈출 수 있습니다." (When turned off, All Mail is searched every time a message is opened, which can make Thunderbird slow or freeze briefly.)
- Saving: no save button; values are saved as soon as they change (`change` event).
- Validation: if a value is not an integer or is outside the allowed range, it is not saved and an error is shown next to that input. Other items can still be saved.
- "Restore defaults" saves every item as its default and updates the screen.
- When the page opens, it reads and shows the stored values. If nothing is stored, it shows the defaults.
- Follows the light/dark color scheme.

### 17.3 Storage format

- Storage: `browser.storage.local`, key `settings`, value is one object with the keys from 17.1.
- Validate item by item when reading. Missing items, or items with the wrong type or range, are replaced individually with their defaults. Unknown keys are ignored.
- The validation and default logic is a module shared by the background and the options page.

### 17.4 How the background applies settings

- The background keeps the valid settings in memory, and the search and cache logic reads these in-memory values **synchronously** (storage is never read during a search).
- Load once with `storage.local.get` at startup. `getLabels` requests that arrive before loading finishes wait for it (section 5 step 0). If loading fails, log it and use the defaults.
- On `storage.onChanged` (area `local`, key `settings`), update the in-memory values, then **clear the whole label cache and mark all in-flight searches as cancelled** (the same as the full invalidation in 9.3), so no results computed with the old settings remain.
  - The folder list cache is not cleared (it stores the unfiltered original and does not depend on settings).
  - The Google account cache is not cleared either.
- Changed settings take effect **from the next time a message is opened**, without restarting. Labels already shown are not refreshed.
- The label cache lifetime used for an entry's expiry is the setting at the time the entry is stored.
- A search in progress runs to the end with the settings at its start (the target folder list is fixed when the search starts). Its result is not cached because of the cancellation mark.

## 18. Constants

For user setting defaults, see 17.1. The following are fixed constants the user cannot change.

| Name | Value |
|---|---|
| Label cache max entries | 1000 |
| Folder list cache TTL | 10 minutes |
| Not-Google cache TTL | 24 hours |
| Retry wait after a failed check | 5 minutes |
| DNS timeout | 2000 ms |
| Google mail domains | `gmail.com`, `googlemail.com` |
| Google MX suffixes | `.google.com`, `.googlemail.com` |
| Gmail system folder regex | see section 6 step 1 (top-level `[Gmail]` or `[Google Mail]` folder and its subfolders) |
| DoH endpoint | `https://dns.google/resolve?name=…&type=MX` |
