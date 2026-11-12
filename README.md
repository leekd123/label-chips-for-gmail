# Label Chips for Gmail

Gmail/Google Workspace IMAP 계정의 메일을 열면, 그 메일에 붙은 Gmail 라벨을 본문 맨 위에 칩으로 보여 주는 Thunderbird 확장.

- Thunderbird 121 이상
- 요구사항 명세: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md)

## 빌드

```powershell
./deploy.ps1
```

`.deploy/label-chips-<version>.xpi`가 생성된다.

## 개발 중 설치

Thunderbird → 부가 기능 및 테마 → 톱니바퀴 → 부가 기능 디버그 → 임시 부가 기능 로드 → `extension/manifest.json` 선택.
