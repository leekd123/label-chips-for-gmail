# Label Chips for Gmail

[한국어](README.ko.md) | **English**

A Thunderbird extension that shows the Gmail labels of a message as chips at the top of the message body when you open a message from a Gmail/Google Workspace IMAP account.

- Thunderbird 121 or later
- Requirements specification: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) (Korean translation: [docs/REQUIREMENTS.ko.md](docs/REQUIREMENTS.ko.md))

## Usage

### How it works

The extension does not ask the Gmail server. Instead, it looks for the same message (the same `Message-ID`) in the folders Thunderbird has already downloaded, and shows the names of those folders as labels. As a result, **labels whose folders Thunderbird has not synchronized yet are not shown.** All Mail, Spam and Trash are not shown as labels by default (they are shown only when they are the folder you opened the message from).

- The folder you are viewing the message from is shown first as a grey chip; the other labels are shown as purple chips.
- Nothing is shown for accounts that are not Google accounts (POP3, other mail services, Local Folders).

### Recommended setting: check all folders for new mail

By default, Thunderbird checks only the Inbox for new mail. To make labels applied by Gmail filters appear on new messages right away, use one of the following.

**Option A — all folders (recommended)**

1. Open Thunderbird **Settings → General** and click **Config Editor** at the bottom.
2. Search for `mail.server.default.check_all_folders_for_new`.
3. Set the value to `true`.
4. Restart Thunderbird.

> On accounts with many folders, checking for new mail may take longer.

**Option B — selected label folders only**

1. In the folder pane, right-click a label folder → **Properties**.
2. Turn on **When getting new messages for this account, always check this folder**.
3. Repeat for each label folder you need.

### Settings

Open **Add-ons Manager → Extensions → Label Chips for Gmail → Options**. Changes are saved immediately and take effect **the next time you open a message**, without restarting Thunderbird (chips already shown are not updated). The **Restore defaults** button saves the default value for every item. The options page is shown in Korean when Thunderbird's UI language is Korean, and in English otherwise.

The options page is in Korean; the labels shown on screen are given in parentheses below.

| Item | Description | Default | Notes |
|---|---|---|---|
| Exclude All Mail (전체보관함 제외) | Leaves All Mail (`[Gmail]/All Mail`) out of the label search. | On | When turned off, All Mail is searched every time you open a message, which can make Thunderbird slow or freeze briefly. |
| Exclude Spam (스팸 제외) | Leaves the Spam folder out of the label search. | On | |
| Exclude Trash (휴지통 제외) | Leaves the Trash folder out of the label search. | On | |
| Label cache lifetime in minutes (라벨 캐시 유지 시간 (분)) | How long labels, once found, are shown without searching again. | 30 | Only integers from 1 to 1440 are saved. Out-of-range input shows an error and the previous value is kept. |

Copying, moving or deleting messages, receiving new mail, folder changes and settings changes trigger a new search regardless of the cache lifetime.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A new message shows only the current folder, not the labels applied by filters | The label folders have not been synchronized yet | Apply the "Recommended setting" above. For now, click the label folder once and open the message again. |
| A label just added in Gmail on the web is not shown | Same as above (the server change has not been synchronized yet) | Same as above |
| No labels are shown at all | The account was not recognized as a Google account (POP3 account, non-IMAP account, failed MX lookup for the domain) | Make sure it is an IMAP account. If it was a network problem, open the message again after 5 minutes. |
| All Mail / Spam / Trash are not shown as labels | They are excluded by default | Turn off the exclusion in the settings if you need them (All Mail can be slow). |
| Labels of the open message do not change | Labels already shown are not refreshed | Select another message, then open this one again. |

## Privacy

- The only network traffic is an MX lookup at `dns.google` for the **domain** of accounts that have no `[Gmail]` folder and whose address is not `gmail.com`/`googlemail.com`.
- Only the settings above are stored. Messages and folders are never modified.

## Build

```powershell
./deploy.ps1
```

This creates `.deploy/label-chips-<version>.xpi`.

## Testing

Uses the built-in test runner of Node.js 22 or later (no external packages, no `package.json`).

```powershell
node --test "tests/*.test.mjs"
```

- `tests/helpers/fake-browser.mjs` emulates the Thunderbird APIs (`messages`, `folders`, `accounts`, `messageDisplay`, `tabs`, `storage`, `fetch`) in memory, and the background modules are loaded from the real files as-is.
- `tests/` is outside `extension/`, so it is not included in the xpi.
- Items that can only be checked in a real Thunderbird (injection into already-open message tabs, dark mode, sticky label row, installation) are checked manually with section 15 of the specification.

## Installing during development

Thunderbird → Add-ons and Themes → gear icon → Debug Add-ons → Load Temporary Add-on → select `extension/manifest.json`.

## License

[MIT](LICENSE)
