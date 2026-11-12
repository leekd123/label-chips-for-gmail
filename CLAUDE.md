# Label Chips for Gmail

Thunderbird MailExtension(MV2). Gmail IMAP 계정의 메일 본문 상단에 라벨(=같은 Message-ID가 들어 있는 폴더)을 칩으로 표시한다.

## 명세

- 유일한 기준 문서: `docs/REQUIREMENTS.md`. 구현 전 해당 절을 읽고, 명세와 다르게 구현해야 하면 먼저 사용자에게 확인한다.
- `[필수]`/표시 없음 = 반드시 준수, `[자유]` = 재량(모듈 분할 등).
- 사용자 설정 기본값·범위는 명세 17.1절, 고정 상수는 18절 값을 그대로 쓴다.

## 구조

- `extension/` — 이 폴더 내용이 그대로 xpi가 된다. 확장에 들어가면 안 되는 파일은 여기에 두지 않는다.
  - `manifest.json`, `images/`, `src/background.html`, `src/background/`(ES 모듈), `src/content/`(메일 표시 스크립트 + CSS), `src/options/`(설정 화면)
- `deploy.ps1` — `.deploy/label-chips-<version>.xpi` 생성.

## 규칙

- 외부 라이브러리·번들러·빌드 도구·package.json 없음. 순수 JS(ES 모듈) + CSS.
- 권한은 manifest에 있는 5개가 전부. 추가 금지.
- `storage.local`에는 사용자 설정(키 `settings`)만 저장한다. 캐시와 그 밖의 상태는 전부 메모리.
- 설정 검증·기본값 로직은 백그라운드와 설정 화면이 같은 모듈을 공유한다. 검색·캐시 로직은 메모리의 설정값을 동기적으로 읽고, 설정이 바뀌면 라벨 캐시 전체를 무효화한다 (명세 17.3, 17.4절).
- `README.md`에는 명세 16절의 "사용 방법"·"문제 해결" 내용을 빠짐없이 싣는다.
- `messages.query`는 반드시 `folderId` 지정, 폴더 하나씩 순차 실행, 폴더 사이 `setTimeout(0)` 양보 (명세 10절). `Promise.all` 병렬화 금지.
- content script 클래스 접두사 `lc-`, 텍스트는 `textContent`만.
- `gecko.id`(`label-chips@leekd123`)는 변경 금지.

## 빌드 / 테스트

```
pwsh ./deploy.ps1
```

수동 테스트: Thunderbird → 부가 기능 관리 → 톱니바퀴 → "부가 기능 디버그" → "임시 부가 기능 로드" → `extension/manifest.json`. 인수 시나리오는 명세 15절.
