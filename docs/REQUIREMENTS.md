# Label Chips for Gmail (Thunderbird 확장) — 요구사항 명세

**한국어** | [English](REQUIREMENTS.en.md)

대상 버전: 0.1.0
이 문서는 확장을 처음부터 구현하기 위한 명세다. 사용자가 관찰하는 동작과, 그 동작을 보장하는 데 필요한 내부 규칙을 모두 적는다.
`[필수]`는 반드시 지켜야 하는 항목, `[자유]`는 구현 재량 항목이다. 표시가 없는 동작 규칙은 `[필수]`로 본다.

---

## 1. 제품 개요

- Gmail/Google Workspace **IMAP** 계정의 메일을 열면, 그 메일에 붙은 Gmail 라벨을 메일 본문 맨 위에 칩 형태로 보여 준다.
- Gmail 라벨은 Thunderbird에서 폴더로 나타난다. 따라서 "같은 `Message-ID`를 가진 메일이 들어 있는 폴더들"을 찾아 그 폴더 경로를 라벨로 표시한다.
- Google 계정이 아니면 아무것도 표시하지 않는다.
- 일부 동작은 설정 화면에서 바꿀 수 있다(17절). 그 외 툴바 버튼 등 다른 UI는 없다.

## 2. 패키징 / 매니페스트

| 항목 | 값 |
|---|---|
| `manifest_version` | `2` |
| `name` | `Label Chips for Gmail` |
| `description` | `Shows Gmail labels at the top of each message` |
| `author` | `leekd123` |
| `version` | `0.1.0` |
| `browser_specific_settings.gecko.id` | `label-chips-for-gmail@leekd123` (최초 배포 후에는 변경 금지 — 바꾸면 다른 확장으로 인식됨) |
| `browser_specific_settings.gecko.strict_min_version` | `121.0` (`folders.query`, `MailFolder.id`, `messages.query`의 `folderId` 사용. `messagesPerPage`는 TB 120+) |
| `icons` | `images/icon-32.png`, `icon-48.png`, `icon-64.png` (32/48/64px PNG, 새로 제작) |
| `background` | `{ "page": "src/background.html" }` — ES 모듈을 쓰기 위해 스크립트 목록이 아닌 **백그라운드 페이지** 사용 |
| `options_ui` | `{ "page": "src/options/options.html" }` — 부가 기능 관리자의 확장 설정 탭에 표시 |
| `permissions` | `messagesModify`, `messagesRead`, `accountsRead`, `storage`, `*://dns.google/*` |

권한 용도:

- `messagesModify`: `messageDisplayScripts.register`, 이미 열려 있는 메일 탭에 대한 `tabs.executeScript/insertCSS` (메일 표시 문서에 스크립트/CSS 주입)
- `messagesRead`: `messageDisplay.getDisplayedMessage`, `messages.query/continueList/abortList`, `messages.onMoved/onCopied/onDeleted/onNewMailReceived`
- `accountsRead`: `accounts.get`, `folders.query`, `folders.on*`
- `*://dns.google/*`: 백그라운드에서 DNS-over-HTTPS 호출

- `storage`: 사용자 설정 저장(`storage.local`)과 변경 감지(`storage.onChanged`). 설정 외의 데이터는 저장하지 않는다.

필요한 권한은 위가 전부다.

프로젝트 구조:

```
label-chips/                 저장소 루트
  extension/                 확장 소스 (이 폴더의 내용이 그대로 xpi가 됨)
    manifest.json
    images/
    src/
      background.html        백그라운드 페이지 (ES 모듈 로드)
      background/            백그라운드 모듈
      content/               메일 표시 스크립트와 CSS
      options/               설정 화면 (HTML/JS/CSS)
  docs/REQUIREMENTS.md
  deploy.ps1
  README.md
```

빌드(`deploy.ps1`, PowerShell): `extension/` **내부 내용**(폴더 자체가 아님, `manifest.json`이 아카이브 루트)을 zip으로 압축해 `.deploy/label-chips-<manifest.version>.xpi`로 저장한다. 경로는 스크립트 위치(`$PSScriptRoot`) 기준으로 잡아 실행 위치와 무관하게 동작해야 하고, `.deploy`가 없으면 생성하며, 같은 이름의 파일은 덮어쓴다. 버전은 `manifest.json`에서 읽는다. `.deploy/`는 gitignore에 넣는다.

## 3. 구성 요소

```
백그라운드 페이지 (상주, 모든 상태는 메모리)
 ├─ 요청 처리기      : content script의 getLabels 요청 처리, 탭별 상태
 ├─ 라벨 서비스      : 라벨 캐시, 진행 중 검색 공유, 무효화
 ├─ 라벨 검색        : 라벨 폴더를 하나씩 조회
 ├─ 라벨 폴더 목록   : 계정 폴더 캐시, 검색 대상 필터, [Gmail] 폴더 감지
 ├─ Google 계정 판별 : [Gmail] 폴더 → 메일 도메인 → MX 조회
 ├─ 설정            : 저장된 설정 로드·검증, 변경 감지
 └─ TTL/LRU 캐시
메일 표시 스크립트 (메일이 표시될 때마다 주입)
 └─ getLabels 요청 → 응답을 DOM으로 렌더링
설정 화면 (options_ui)
 └─ 설정 표시·저장
```

모듈 분할 방식은 `[자유]`. 아래 동작 규칙은 `[필수]`.

## 4. 메시지 프로토콜 (content ↔ background)

- 요청: `browser.runtime.sendMessage({ command: "getLabels" })`. 인자 없음. 어떤 메일인지는 백그라운드가 `sender.tab.id`로 판단한다.
- 응답: `{ labels: Array<{ path: string, active: boolean }> }`
  - `path`: 폴더 경로에서 맨 앞 `/` 하나를 뗀 문자열 (예: `INBOX`, `[Gmail]/Sent Mail`, `업무/프로젝트A`). 지역화된 이름이 아니라 `MailFolder.path` 원문.
  - `active`: 현재 표시 중인 메일이 속한 폴더이면 `true`.
- "표시할 것 없음"은 항상 `{ labels: [] }`.
- `onMessage` 리스너는 `message?.command !== "getLabels"`이면 `undefined`를 반환(다른 리스너에 양보)하고, 그 외에는 **Promise를 반환**한다. 처리 중 예외는 `console.error` 후 `{ labels: [] }`로 응답한다(요청 측에 reject가 전달되지 않음).

## 5. 요청 처리 흐름 (`getLabels`)

탭별 상태 `tabStates: Map<tabId, { requestId: number, displayedKey: string|null }>`.

0. 설정 로드가 끝날 때까지 기다린다(17.4). 로드는 시작 시 한 번뿐이므로 이후 요청은 지연 없이 통과한다.
1. `tabId`가 `undefined`/`null`이면 `{labels: []}`.
2. 탭 상태가 없으면 `{requestId: 0, displayedKey: null}`로 생성. `requestId`를 1 증가시키고 이 요청의 번호로 기억한다.
   - **stale 판정**: `tabStates.get(tabId)?.requestId !== 내 번호` (같은 탭에 새 요청이 왔거나 탭이 닫힘).
3. `messageDisplay.getDisplayedMessage(tabId)` 호출. 끝난 뒤 stale이면 `{labels: []}`.
4. `messageHeader.folder.accountId` 또는 `messageHeader.headerMessageId`가 없으면 `displayedKey = null`로 두고 `{labels: []}`. (예: .eml 파일, 폴더 없는 메일)
5. `key = "${accountId}_${headerMessageId}"`, `currentPath = 현재 폴더의 라벨 경로`. `displayedKey = key`로 기록.
   - 키에 `messageHeader.id`를 쓰면 안 된다. 폴더별 사본마다 id가 달라 캐시를 공유할 수 없다.
6. 라벨 캐시에 `key`가 있으면(빈 배열 포함) **Google 계정 판별 없이** 즉시 응답 생성(7절).
7. `isGoogleAccount(accountId)`가 `false`이거나, 판별 후 stale이면 `{labels: []}`.
8. 라벨 검색 실행(8절). 계속 조건은 "`key`가 **어느 탭에서든** `displayedKey`로 남아 있는가".
9. stale이면 `{labels: []}`. 검색 결과가 `null`(중단됨)인데 stale이 아니면 — 다른 메일로 넘어갔다가 돌아오는 사이, 중단이 결정된 검색에 합류한 경우다 — 8단계를 **한 번만** 다시 실행한다. 다시 실행한 결과도 `null`이거나 그 뒤 stale이면 `{labels: []}`, 아니면 응답 생성.

`tabs.onRemoved`에서 해당 `tabId`의 상태를 삭제한다.

## 6. Google 계정 판별

`isGoogleAccount(accountId): Promise<boolean>`

판별 순서 (결과는 `true` / `false` / `null`=확정 불가):

1. 계정 폴더 목록(9절의 캐시된 목록)에 경로가 정규식 `^\/\[(Gmail|Google Mail)\](\/|$)`에 맞는 폴더가 하나라도 있으면 `true`. 네트워크 조회 없음. 폴더 조회가 실패하면 로그만 남기고 다음 단계로.
2. `accounts.get(accountId)`. 실패하거나 계정이 없으면 `null`.
3. `account.type !== "imap"`이면 `false`.
4. 계정의 모든 identity의 `email`에서 `@` 뒤 도메인을 소문자로 모은다(중복 제거). `gmail.com` 또는 `googlemail.com`이 있으면 `true`.
5. 나머지 도메인을 **순서대로 하나씩** MX 조회. 하나라도 Google이면 즉시 `true`. 모든 도메인이 확정적으로 아니면 `false`, 확정 불가가 하나라도 있었으면 `null`. (도메인이 없으면 `false`)

MX 조회:

- `GET https://dns.google/resolve?name=<encodeURIComponent(domain)>&type=MX`
- 타임아웃 2000ms (`AbortController`로 중단, 타이머는 항상 정리)
- HTTP 응답이 ok가 아니면 `null`. 예외/타임아웃이면 로그 후 `null`.
- `Answer[]` 중 Google MX가 하나라도 있으면 `true`.
  - 판정: `answer.data`(예: `"10 aspmx.l.google.com."`)를 trim → 공백으로 나눈 **마지막 토큰** → 소문자 → 끝의 `.` 제거 → `.google.com` 또는 `.googlemail.com`으로 끝나는가. (값이 없으면 `false`)
- 그 외에는 `Status`가 `0`(NOERROR) 또는 `3`(NXDOMAIN)이면 `false`, 다른 값이면 `null`.

캐싱 (메모리, accountId 단위):

| 결과 | 캐시되는 값 | 유효 시간 |
|---|---|---|
| `true` | `true` | 무기한(세션 동안) |
| `false` | `false` | 24시간 |
| `null` | `false` | 5분 (이후 재시도) |

- 같은 계정에 대한 판별이 진행 중이면 **같은 Promise를 공유**한다(중복 조회 금지). 끝나면 성공/실패와 무관하게 진행 중 목록에서 제거.

## 7. 응답 생성 규칙

입력: 라벨 경로 목록 `paths`, 현재 폴더 경로 `currentPath`.

- `currentPath`가 비어 있지 않으면: `[currentPath, ...paths에서 currentPath를 뺀 나머지(원래 순서 유지)]`
- 비어 있으면: `paths` 그대로
- 각 항목의 `active = (path === currentPath)`

결과적으로:

- 현재 폴더는 **항상 맨 앞**에, 회색(active)으로 표시된다. 현재 폴더가 검색 제외 폴더(휴지통/스팸/전체보관함)여도 표시된다.
- 나머지 순서는 `folders.query`가 반환한 폴더 순서.
- 캐시는 "경로 목록"만 저장하고 `active`는 요청마다 다시 계산한다(같은 메일의 여러 사본이 캐시를 공유하므로).
- Google 계정의 메일은 다른 라벨이 없어도 현재 폴더 칩 하나는 표시된다.

## 8. 라벨 검색

### 8.1 검색 대상 폴더

계정의 폴더 중 다음을 **모두** 만족하는 것:

- `folder.id`가 있음
- `isRoot`, `isVirtual`, `isTag`, `isUnified`가 모두 아님
- `specialUse`에 **제외 대상**이 없음. 제외 대상은 설정(17절)에서 켜진 것들이며 기본값은 `archives`, `junk`, `trash` 전부다.
  - `archives` = Gmail 전체보관함(`[Gmail]/All Mail`). 모든 메일이 들어 있어 스캔 비용이 가장 크므로 기본 제외.
  - 받은편지함, 보낸편지함, 임시보관함, 별표, 중요 등은 대상에 **포함**.

### 8.2 조회 조건

- `headerMessageId`: 표시 중인 메일의 `headerMessageId`
- `folderId`: 대상 폴더 id — **계정 전체 조회 금지, 반드시 폴더 하나씩**
- `messagesPerPage: 1` — 첫 일치를 찾는 즉시 첫 페이지가 반환되게 한다. 기본값(100)이면 일치가 1건뿐인 폴더는 순회가 끝나거나 1초가 지나야 반환되어 조기 종료(8.3)가 동작하지 않는다.
- 날짜 조건(`fromDate`/`toDate`)은 쓰지 않는다. `messages.query`는 폴더의 모든 헤더를 순회하며 조건을 하나씩 비교하므로 날짜 조건이 순회량을 줄이지 못하고, 같은 `Message-ID`의 사본은 날짜도 같아 결과에도 영향이 없다.

### 8.3 절차

대상 폴더를 순서대로 순회하며:

1. 폴더가 현재 폴더(`folder.id === messageHeader.folder.id`)면 조회 없이 결과에 추가하고 다음으로. (양보·중단 검사도 하지 않음)
2. 순회 인덱스가 0보다 크면 `setTimeout(0)`으로 **이벤트 루프에 양보**한다.
3. 계속 조건을 검사한다. `false`면 검색 전체를 중단하고 `null` 반환(부분 결과 버림).
4. `messages.query({...조건, folderId})` 실행.
   - 결과 페이지에 메일이 1건 이상 있으면 "포함". 이때 `page.id`가 있으면 `messages.abortList(page.id)`를 호출해 남은 목록을 중단한다(API가 없거나 실패해도 무시, 기다리지 않음).
   - 메일이 없고 `page.id`가 있으면 `messages.continueList(page.id)`로 다음 페이지를 받아 같은 판정을 **반복**한다. 메일이 있는 페이지가 나오면 "포함"(위와 같이 `abortList`), `page.id`가 없는 빈 페이지가 나오면 "미포함".
5. 폴더 하나의 조회가 예외를 던지면 `console.error` 후 그 폴더만 건너뛰고 계속한다.

반환: 포함된 폴더들의 라벨 경로 배열(폴더 순서), 또는 중단 시 `null`.

### 8.4 검색 범위의 한계

`messages.query`는 Gmail 서버가 아니라 **Thunderbird가 이미 동기화한 로컬 폴더 데이터**만 검색한다. 아직 동기화되지 않은 라벨 폴더에 있는 사본은 찾지 못한다. 이 한계는 9.3절의 새 메일 무효화와 16절의 Thunderbird 권장 설정(모든 폴더에서 새 메일 확인)으로 보완한다.

## 9. 캐시

모든 캐시는 **메모리 전용**이다. Thunderbird 재시작 시 초기화된다. 영구 저장소(`storage.local`)에는 사용자 설정만 저장한다.

### 9.1 공통 캐시 동작 (TTL + LRU)

- 생성 옵션: 기본 TTL(기본 무한), 최대 개수(기본 무한). `set` 시 항목별 TTL 지정 가능.
- `get`: 없으면 `undefined`. 만료(`now >= expiresAt`)면 삭제 후 `undefined`. 유효하면 **LRU 순서만 갱신**하고 값 반환 — **만료 시각은 연장하지 않는다**.
- `set`: 같은 키를 먼저 지운 뒤, 개수가 최대치 이상이면 가장 오래 참조되지 않은 것부터 제거하고 저장. `expiresAt = now + ttl`.
- `delete`, `clear` 제공.

### 9.2 캐시 목록

| 캐시 | 키 | 값 | TTL | 최대 개수 |
|---|---|---|---|---|
| 라벨 | `accountId_headerMessageId` | 라벨 경로 `string[]` | 설정값 (기본 30분) | 1000 (LRU) |
| 폴더 목록 | `accountId` | `folders.query({accountId})` 결과 전체 | 10분 | 무제한 |
| Google 계정 여부 | `accountId` | `boolean` | 6절 표 | 무제한 |

- 폴더 목록 캐시는 필터링 전 원본을 저장하고, 라벨 폴더 필터와 `[Gmail]` 감지가 함께 사용한다.
- 라벨 캐시에는 **완료된 검색 결과만** 저장한다. 중단된 검색(`null`)과 무효화된 검색 결과는 저장하지 않는다.

### 9.3 무효화

Gmail에서 라벨 추가/제거/이동은 Thunderbird에서 폴더 간 복사/이동/삭제로 나타난다.

| 이벤트 | 동작 |
|---|---|
| `messages.onMoved(original, moved)` | 두 목록의 모든 메일에 대해 메일 단위 무효화 |
| `messages.onCopied(original, copied)` | 두 목록의 모든 메일에 대해 메일 단위 무효화 |
| `messages.onDeleted(list)` | 목록의 모든 메일에 대해 메일 단위 무효화 |
| `messages.onNewMailReceived(folder, messages)` — `addListener(listener, true)`로 등록 | `messages` 목록의 모든 메일에 대해 메일 단위 무효화 |
| `folders.onCreated / onDeleted / onRenamed / onMoved` | 폴더 목록 캐시 전체 삭제 + 라벨 캐시 전체 삭제 + 진행 중 검색 전부 취소 표시 |
| 사용자 설정 변경 (`storage.onChanged`) | 라벨 캐시 전체 삭제 + 진행 중 검색 전부 취소 표시 (17.4) |

- 메일 목록은 페이지네이션될 수 있다. `page.id`가 있는 동안 `messages.continueList`로 끝까지 순회한다. 순회 중 예외는 로그만 남긴다. 리스너는 이 작업을 기다리지 않는다.
- **메일 단위 무효화**(`accountId`=`message.folder?.accountId`, `headerMessageId`; 둘 중 하나라도 없으면 무시):
  1. 라벨 캐시에서 해당 키 삭제
  2. 그 키로 진행 중인 검색이 있으면 "취소됨" 표시를 하고 진행 중 목록에서 제거
- 취소 표시된 검색은 **강제로 멈추지 않는다**. 계속 돌아 기다리던 요청에게 결과를 돌려주지만 **캐시에 기록하지 않는다**. 이후 같은 메일의 새 요청은 새 검색을 시작한다.
- `onNewMailReceived`가 필요한 이유: Gmail 필터가 서버에서 붙인 라벨은, Thunderbird가 그 라벨 폴더를 동기화하는 시점에 그 폴더의 "새 메일"로 나타난다. 그 전에 메일을 열었다면 "라벨 없음" 결과가 캐시돼 있으므로, 이 이벤트에서 지워야 다음에 열 때 다시 검색한다.
  - 두 번째 인자 `monitorAllFolders = true`(TB 121+)로 등록해 받은편지함·일반 폴더뿐 아니라 보낸편지함 등 특수 폴더까지 감시한다.
  - 확장은 폴더 동기화를 강제하지 않는다(그런 API가 없다). 동기화 자체는 Thunderbird 설정에 달려 있다(16절).
- 폴더 이벤트 리스너는 해당 이벤트가 API에 없으면 등록을 건너뛴다.
- 이미 화면에 그려진 라벨은 갱신하지 않는다. 메일을 다시 표시할 때 반영된다.

## 10. 비동기 처리 / UI 프리징 방지 **[핵심]**

배경: `messages.query`는 대상 폴더의 메일을 Thunderbird **메인 스레드**에서 순회한다. 계정 전체나 큰 폴더를 한 번에 조회하면 UI가 멈춘다. 확장 쪽에서 쿼리 자체를 다른 스레드로 옮길 방법은 없으므로, 아래 규칙으로 "한 번에 하는 일의 크기"와 "불필요한 일의 양"을 줄인다. 전부 `[필수]`.

1. **폴더 단위 분할**: 조회는 항상 `folderId`를 지정해 한 폴더씩, **순차적으로**(동시 실행 금지 — `Promise.all`로 병렬화하면 메인 스레드 작업이 몰린다) 수행한다.
2. **폴더 사이 양보**: 폴더 조회 사이마다 `setTimeout(0)`으로 매크로태스크 경계를 만들어 UI 이벤트가 처리되게 한다. (`await Promise.resolve()` 같은 마이크로태스크 양보는 효과가 없다)
3. **가장 비싼 폴더 제외**: 기본 설정에서 전체보관함(`archives`), 스팸, 휴지통은 조회하지 않는다. 사용자가 설정에서 제외를 끄면 조회 대상이 되므로, 설정 화면에 성능 경고를 표시한다(17.2).
4. **현재 폴더는 조회하지 않음**: 이미 그 폴더에 있다는 것을 알기 때문.
5. **조기 종료**: `messagesPerPage: 1`로 조회해 한 폴더에서 1건을 찾는 즉시 결과를 받고, 남은 순회를 `abortList`로 중단한다.
6. **폴더 단위 취소**: 매 폴더 조회 직전에 "이 메일이 아직 어느 탭에서든 표시 중인가"를 검사해, 아니면 남은 폴더 조회를 모두 포기한다. 메일을 빠르게 넘길 때 스캔이 누적되지 않게 하는 장치다.
   - 탭 A에서 메일을 넘겨도 탭 B가 같은 메일을 표시 중이면 계속한다.
   - A → B → A로 돌아오면 A의 검색이 살아 있는 한 이어서 공유한다.
7. **진행 중 검색 공유**: 같은 키의 검색이 진행 중이면 새로 시작하지 않고 그 Promise를 공유한다. 검색이 끝나면(성공/중단/예외 모두) 진행 중 목록에서 제거하되, 그 사이 무효화로 다른 검색이 같은 키에 등록됐다면 그것을 지우지 않는다.
8. **stale 응답 폐기**: 모든 `await` 뒤(표시 메일 조회, 계정 판별, 검색)에 탭의 `requestId`를 확인해, 최신 요청이 아니면 `{labels: []}`로 끝낸다. 최신 요청이 중단된 결과(`null`)를 받은 경우에만 검색을 한 번 다시 시작한다(5절 9단계).
9. **캐시 우선**: 캐시 적중 시 계정 판별·검색 없이 즉시 응답한다.
10. **네트워크 제한**: MX 조회는 2초 타임아웃, 계정당 1회로 공유, 실패 시 5분간 재시도하지 않는다. `[Gmail]` 폴더가 있는 일반적인 Gmail 계정은 네트워크 조회 자체가 없다.
11. **렌더링 비차단**: content script는 응답을 기다리는 동안 메일 표시를 막지 않는다. 메일 본문이 먼저 보이고 라벨은 응답이 온 뒤 삽입된다.
12. **이벤트 리스너 비차단**: 무효화 리스너와 시작 시 스크립트 등록은 기다리지 않고 실행하며, 실패는 로그만 남긴다.

알려진 한계(0.1.0에서 허용): `messages.query`는 색인 없이 폴더의 모든 헤더를 순회하고, 폴더 하나의 조회 자체는 쪼갤 수 없으므로, 메일이 매우 많은 단일 라벨 폴더는 그 폴더를 조회하는 동안 짧게 끊길 수 있다.

## 11. 메일 표시 스크립트 (UI)

- 등록: 백그라운드 시작 시 `messageDisplayScripts.register({ js: [...], css: [...] })` 1회. 메일이 표시될 때마다(3-pane 미리보기, 메일 탭, 별도 창) 메일 본문 문서에 주입된다.
- 이미 열려 있는 메일: `messageDisplayScripts`는 등록 **이후**에 표시되는 메일에만 적용된다. 확장 설치·업데이트·재활성화 직후 이미 표시돼 있던 메일에도 칩이 보이도록, 등록 직후 한 번 `tabs.query({})`로 탭을 모아 `type`이 `mail` 또는 `messageDisplay`인 탭마다 같은 CSS와 JS를 `tabs.insertCSS` / `tabs.executeScript`로 주입한다.
  - 탭 하나의 주입 실패(표시 중인 메일이 없는 탭 등)는 무시하고 다음 탭으로 넘어간다. 이 작업은 기다리지 않는다.
  - 구현 시 확인: 메일 탭에 대한 `tabs.executeScript`가 `messagesModify` 권한만으로 동작하는지 실제 Thunderbird에서 검증한다. 동작하지 않으면 이 항목은 구현하지 않고 알려진 한계로 README에 적는다(권한을 추가하지 않는다).
- 동작:
  1. `{command: "getLabels"}` 전송. 실패하면 조용히 종료.
  2. `labels`가 없거나 비었으면 DOM을 건드리지 않고 종료.
  3. `<div class="lc-labels">` 안에 라벨마다 `<span class="lc-label">`(active면 `lc-label lc-label-active`)를 만들고, 텍스트는 `textContent = path`로 넣는다(HTML 삽입 금지).
  4. 문서에 이미 `.lc-labels` 요소가 있으면 모두 제거한다(같은 문서에 스크립트가 두 번 주입된 경우의 중복 방지).
  5. `document.body.prepend(container)` — 본문 맨 앞.
- 스타일:

| 선택자 | 스타일 |
|---|---|
| `.lc-labels` | `background-color: Canvas`(라이트/다크 자동 대응 시스템 색), `padding: 0.5rem`, `display: flex`, `flex-wrap: wrap`, `gap: 6px 10px`, `position: sticky; top: 0`, `z-index: 1000` |
| `.lc-label` | `background: rgb(155, 157, 226)`, `border-radius: 5px`, `padding: 2px 6px`, `color: white`, `font-size: 14px`, `font-family: "Open Sans", system-ui, sans-serif` |
| `.lc-label-active` | `background: rgb(131, 131, 131)` |

  - 라벨 줄은 스크롤해도 본문 상단에 고정된다.
  - 클래스 접두사 `lc-`는 메일 본문 CSS와의 충돌 방지용이다.
- 라벨 칩은 표시 전용이다. 클릭 동작 없음.

## 12. 시작 시 동작 (백그라운드 로드 순서)

1. `runtime.onMessage`, `tabs.onRemoved`, `messages.onMoved/onCopied/onDeleted/onNewMailReceived`, `folders.on*` 리스너 등록
2. 설정 로드 시작(기다리지 않음, 17.4)과 `storage.onChanged` 리스너 등록
3. `messageDisplayScripts.register(...)`. 실패는 로그만.
4. 이미 열려 있는 메일 탭에 스크립트/CSS 주입(11절). 기다리지 않음.

## 13. 오류 처리 원칙

- 어떤 오류도 사용자에게 보이지 않는다. 백그라운드는 `console.error`로만 기록하고, 결과는 "라벨 없음" 또는 "해당 폴더 건너뜀"으로 수렴한다.
- content script는 오류를 기록하지 않고 종료한다.

## 14. 비기능 요구사항

- 외부 라이브러리·빌드 도구·번들러 없음. 순수 JS(ES 모듈) + CSS.
- 외부 통신은 `dns.google` MX 조회뿐이며, 전송되는 것은 계정 메일 주소의 **도메인**뿐이다(`gmail.com`/`googlemail.com`이거나 `[Gmail]` 폴더가 있으면 전송 없음).
- 영구 저장 데이터는 사용자 설정뿐이다. 메일·폴더·계정 정보는 저장하지 않는다.
- 메일·폴더를 수정하지 않는다(읽기 전용 동작).

## 15. 인수 테스트 시나리오

| # | 상황 | 기대 결과 |
|---|---|---|
| 1 | Gmail IMAP 계정, INBOX의 메일(라벨 `업무` 있음) 열기 | `INBOX`(회색) + `업무`(보라) 순으로 본문 상단 표시 |
| 2 | 같은 메일을 `업무` 폴더에서 열기 | `업무`(회색)가 맨 앞, `INBOX`(보라). 재검색 없이 캐시 사용 |
| 3 | 라벨이 없는 메일 | 현재 폴더 칩 하나만 표시 |
| 4 | 휴지통/스팸/전체보관함에서 메일 열기 | 현재 폴더가 회색으로 맨 앞에 표시. 다른 메일의 라벨 목록에는 이 폴더들이 나타나지 않음 |
| 5 | Google이 아닌 IMAP 계정, POP3 계정, 로컬 폴더 | 아무것도 표시하지 않음 |
| 6 | `[Gmail]` 폴더가 없는 커스텀 도메인 Workspace 계정 | MX 조회 후 라벨 표시 |
| 7 | 오프라인/DNS 실패 상태에서 6번 계정 | 표시 없음. 5분 뒤 다시 열면 재시도 |
| 8 | 폴더가 많은 계정에서 방향키로 메일을 빠르게 넘김 | UI가 멈추지 않음. 지나친 메일의 검색은 중단되고 마지막 메일의 라벨만 표시 |
| 9 | 메일을 다른 폴더로 복사/이동/삭제한 뒤 다시 열기 | 바뀐 라벨이 반영됨 (30분 캐시를 기다리지 않음) |
| 10 | 폴더 생성/삭제/이름 변경 후 메일 열기 | 새 폴더 구조 기준으로 다시 검색 |
| 11 | 같은 메일을 두 탭에서 동시에 열기 | 검색은 한 번만 실행되고 두 탭 모두 표시 |
| 12 | 검색 중 탭 닫기 | 다른 탭에서 표시 중이 아니면 남은 폴더 검색 중단 |
| 13 | 다크 모드 | 라벨 줄 배경이 메일 문서 색 구성표를 따름 |
| 14 | 긴 메일 스크롤 | 라벨 줄이 상단에 고정 |
| 15 | Thunderbird 재시작 후 메일 열기 | 캐시 없이 처음부터 다시 검색해 표시 |
| 16 | `deploy.ps1`을 다른 디렉터리에서 실행 | `.deploy/label-chips-<버전>.xpi` 생성, 설치 가능 |
| 17 | Gmail 필터로 라벨이 붙는 새 메일을 받은편지함에서 바로 열기 (모든 폴더 확인 설정 **꺼짐**) | 현재 폴더 칩만 표시 (라벨 폴더 미동기화 — 정상 동작) |
| 18 | 17번 직후 라벨 폴더를 클릭해 동기화한 뒤 그 메일을 다시 열기 | 30분을 기다리거나 재시작하지 않아도 라벨 표시 |
| 19 | 모든 폴더 확인 설정 **켜짐** 상태에서 필터 라벨이 붙는 새 메일 수신 후 열기 | 라벨 표시. 라벨 폴더 동기화보다 먼저 열었다면 다시 열 때 표시 |
| 20 | 설정을 한 번도 바꾸지 않은 상태 | 모든 동작이 기본값(세 폴더 제외, 캐시 30분)으로 수행됨 |
| 21 | 설정에서 "휴지통 제외"를 끈 뒤, 휴지통에도 사본이 있는 메일을 다른 폴더에서 열기 | 재시작 없이 휴지통 경로가 라벨로 표시됨 |
| 22 | 메일을 열어 둔 채 확장을 설치(또는 껐다 켜기) | 메일을 다시 열지 않아도 칩이 표시됨. 칩 줄은 하나만 생김 |
| 23 | 설정 화면에 범위를 벗어난 값 입력 | 저장되지 않고 오류 표시. 동작은 이전 값 유지 |
| 24 | "기본값으로 되돌리기" 실행 | 모든 항목이 기본값으로 저장되고 즉시 적용 |
| 25 | Thunderbird 재시작 | 바꾼 설정이 유지됨 |
| 26 | 검색이 끝나기 전에 메일 A → B → A로 빠르게 되돌아옴 | A의 라벨이 표시됨 (빈 채로 남지 않음) |

## 16. 사용자 매뉴얼 요구사항

`README.md`에 아래 내용을 담은 "사용 방법"과 "문제 해결" 절을 둔다. 문구는 다듬어도 되지만 항목과 절차는 빠뜨리지 않는다.

### 16.1 동작 원리 안내 (한 문단)

- 이 확장은 Gmail 서버에 직접 묻지 않고, Thunderbird가 내려받은 폴더들에서 같은 메일을 찾아 라벨로 보여 준다.
- 따라서 **Thunderbird가 아직 동기화하지 않은 라벨 폴더의 라벨은 표시되지 않는다.**
- 전체보관함·스팸·휴지통은 라벨로 표시하지 않는다(현재 열어 본 폴더인 경우만 표시).

### 16.2 권장 설정: 모든 폴더에서 새 메일 확인

Thunderbird는 기본적으로 받은편지함만 새 메일을 확인한다. Gmail 필터로 자동 분류된 라벨이 새 메일에 바로 보이게 하려면 다음 중 하나를 설정한다.

방법 A — 모든 폴더 (권장):

1. Thunderbird **설정 → 일반** 맨 아래의 **설정 편집기**를 연다.
2. `mail.server.default.check_all_folders_for_new`를 검색한다.
3. 값을 `true`로 바꾼다.
4. Thunderbird를 재시작한다.

방법 B — 특정 라벨 폴더만:

1. 폴더 창에서 라벨 폴더를 오른쪽 클릭 → **속성**.
2. **새 메시지를 받을 때 항상 이 폴더 확인**(영문: *When getting new messages for this account, always check this folder*)을 켠다.
3. 필요한 라벨 폴더마다 반복한다.

안내할 점: 방법 A는 폴더가 많은 계정에서 새 메일 확인 시간이 늘어날 수 있다.

### 16.3 문제 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| 새 메일에 현재 폴더 라벨만 보이고 자동 분류 라벨이 안 보임 | 라벨 폴더가 아직 동기화되지 않음 | 16.2 설정 적용. 당장은 해당 라벨 폴더를 한 번 클릭한 뒤 메일을 다시 연다 |
| 방금 Gmail 웹에서 붙인 라벨이 안 보임 | 위와 같음 (서버 변경이 아직 동기화되지 않음) | 위와 같음 |
| 라벨이 전혀 표시되지 않음 | Google 계정으로 판별되지 않음 (POP3 계정, IMAP이 아닌 계정, 도메인 MX 조회 실패) | IMAP 계정인지 확인. 네트워크 문제였다면 5분 뒤 메일을 다시 연다 |
| 전체보관함/스팸/휴지통이 라벨로 안 보임 | 기본 설정에서 제외됨 | 필요하면 설정에서 제외를 끈다 (전체보관함은 느려질 수 있음) |
| 열려 있는 메일의 라벨이 바뀌지 않음 | 이미 표시된 라벨은 갱신하지 않음 | 다른 메일을 선택했다가 다시 연다 |

### 16.4 설정 안내

설정 화면을 여는 방법(부가 기능 관리자 → 확장 → 설정)과 17.1의 각 항목 설명·기본값·주의사항을 README에 싣는다.

## 17. 사용자 설정

### 17.1 설정 항목

| 키 | 화면 표시 이름 | 형식 | 기본값 | 허용 범위 | 영향 |
|---|---|---|---|---|---|
| `excludeArchives` | 전체보관함 제외 | 불리언 | `true` | — | 8.1 |
| `excludeJunk` | 스팸 제외 | 불리언 | `true` | — | 8.1 |
| `excludeTrash` | 휴지통 제외 | 불리언 | `true` | — | 8.1 |
| `labelCacheMinutes` | 라벨 캐시 유지 시간 (분) | 정수 | `30` | `1`–`1440` | 9.2 |

위 표에 없는 값(18절의 고정 상수)은 사용자가 바꿀 수 없다.

### 17.2 설정 화면

- 매니페스트의 `options_ui`로 제공한다. 별도 프레임워크 없이 HTML/JS/CSS로 만든다.
- 구성:
  - "검색" 영역: 제외 폴더 체크박스 3개
  - "캐시" 영역: 라벨 캐시 유지 시간(숫자 입력)
  - "기본값으로 되돌리기" 버튼
- 각 항목 아래에 한 줄 설명을 둔다. 다음 항목에는 경고 문구를 표시한다.
  - 전체보관함 제외: "끄면 메일을 열 때마다 전체보관함을 검색하므로 Thunderbird가 느려지거나 잠시 멈출 수 있습니다."
- 저장 방식: 저장 버튼 없이 값이 바뀔 때(`change` 이벤트) 바로 저장한다.
- 입력 검증: 정수가 아니거나 허용 범위를 벗어나면 저장하지 않고 해당 입력 옆에 오류를 표시한다. 다른 항목의 저장은 막지 않는다.
- "기본값으로 되돌리기"는 모든 항목을 기본값으로 저장하고 화면에 반영한다.
- 화면을 열 때 저장된 값을 읽어 표시한다. 저장된 값이 없으면 기본값을 표시한다.
- 라이트/다크 색 구성표를 따른다.

### 17.3 저장 형식

- 저장소: `browser.storage.local`, 키 `settings`, 값은 17.1의 키를 가진 객체 하나.
- 읽을 때 항목별로 검증한다. 키가 없거나 형식·범위가 맞지 않는 항목은 그 항목만 기본값으로 대체한다. 알 수 없는 키는 무시한다.
- 검증·기본값 로직은 백그라운드와 설정 화면이 같은 모듈을 공유한다.

### 17.4 백그라운드 적용 규칙

- 백그라운드는 유효한 설정을 메모리에 들고 있고, 검색·캐시 로직은 이 메모리 값을 **동기적으로** 읽는다(검색 도중 저장소를 읽지 않는다).
- 시작 시 `storage.local.get`으로 한 번 로드한다. 로드가 끝나기 전에 온 `getLabels` 요청은 로드 완료를 기다린 뒤 처리한다(5절 0단계). 로드가 실패하면 로그를 남기고 기본값을 쓴다.
- `storage.onChanged`(영역 `local`, 키 `settings`)에서 메모리 값을 갱신한 뒤, **라벨 캐시 전체를 지우고 진행 중인 검색을 모두 취소 표시**한다(9.3의 전체 무효화와 같은 동작). 이전 설정으로 구한 결과가 남지 않게 하기 위함이다.
  - 폴더 목록 캐시는 지우지 않는다(필터링 전 원본을 저장하므로 설정과 무관).
  - Google 계정 판별 캐시도 지우지 않는다.
- 변경된 설정은 재시작 없이 **다음에 메일을 열 때부터** 적용된다. 이미 표시된 라벨은 갱신하지 않는다.
- 라벨 캐시 유지 시간은 항목을 저장할 때의 설정값으로 만료 시각을 정한다.
- 진행 중이던 검색은 시작 시점의 설정으로 끝까지 수행한다(검색 시작 시 대상 폴더 목록을 확정). 결과는 취소 표시 때문에 캐시되지 않는다.

## 18. 상수 요약

사용자 설정 기본값은 17.1 참조. 아래는 사용자가 바꿀 수 없는 고정 상수다.

| 이름 | 값 |
|---|---|
| 라벨 캐시 최대 개수 | 1000 |
| 폴더 목록 캐시 TTL | 10분 |
| Google 아님 캐시 TTL | 24시간 |
| 판별 실패 재시도 대기 | 5분 |
| DNS 타임아웃 | 2000ms |
| Google 메일 도메인 | `gmail.com`, `googlemail.com` |
| Google MX 접미사 | `.google.com`, `.googlemail.com` |
| Gmail 시스템 폴더 정규식 | 6절 1번 참조 (`[Gmail]` 또는 `[Google Mail]` 최상위 폴더 및 그 하위) |
| DoH 엔드포인트 | `https://dns.google/resolve?name=…&type=MX` |
