# CPX 기록판 — 배포 가이드 (운영자용)

이 저장소는 **한 번만 배포하면 됩니다.** 유저는 각자 Firebase 프로젝트를 만들 필요가 없고,
배포된 주소에 가입만 하면 됩니다.

전체 구조:

```
Claude Code (유저 PC)          Cloudflare Worker            Firebase
  cpx 플러그인                    자격증명 보관 안 함           Auth + Firestore
  └ Stop 훅 ──평가 감지──▶  페어링 토큰 → ID token ──▶  records/{id} 생성
                                                              ▲
                                          웹 기록판(GitHub Pages)에서 조회 ─┘
```

---

## 0. 필요한 도구

**Node.js는 필요 없습니다.** 이 PC에 이미 있는 `git` 과 `curl` 만으로 전부 됩니다.
Firebase CLI(`firebase-tools`)와 Wrangler는 둘 다 npm 패키지라 쓰지 않고,
대신 **웹 대시보드**에서 같은 일을 합니다.

| 원래 CLI로 하던 것 | 대신 |
|---|---|
| `firebase deploy` (규칙) | Firebase 콘솔 → Firestore → **규칙** 탭에 붙여넣기 |
| `firebase deploy` (색인) | Firebase 콘솔 → Firestore → **색인** 탭에서 생성 |
| `firebase deploy` (호스팅) | **GitHub Pages** (Firebase Hosting은 CLI 전용이라 사용 안 함) |
| `wrangler deploy` | Cloudflare 대시보드의 온라인 편집기에 붙여넣기 |

> 나중에 Node를 설치하면 `firebase-tools` + `wrangler` 로 이 저장소의
> `firebase.json` / `firestore.indexes.json` / `wrangler.toml` 을 그대로 써서
> 명령 한 줄로 배포할 수 있습니다. 그 파일들은 남겨뒀습니다.

---

## 1. Firebase 콘솔 세팅

https://console.firebase.google.com 에 구글 계정으로 접속합니다.

### 1-1. 프로젝트 만들기
**프로젝트 추가** → 이름 입력(예: `cpx-tracker`) → Google 애널리틱스는 **사용 안 함**으로 두면 됩니다.

### 1-2. Authentication 켜기
**빌드 → Authentication → 시작하기 → Sign-in method** 탭 →
**이메일/비밀번호** 선택 → **사용 설정** 켜고 저장. (하단 "이메일 링크"는 끈 채로.)

### 1-3. Firestore 만들기
**빌드 → Firestore Database → 데이터베이스 만들기**

- 위치: **asia-northeast3 (서울)** — 한 번 정하면 못 바꿉니다
- 모드: **프로덕션 모드**로 시작 (1-5에서 우리 규칙으로 덮어씁니다)

### 1-4. 웹 앱 등록해서 설정값 얻기
**⚙️ 프로젝트 설정 → 일반** → 아래로 스크롤 → **내 앱** → 웹 아이콘 `</>`
→ 닉네임 아무거나 → **앱 등록**. 이런 객체가 나옵니다:

```js
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "cpx-tracker-xxxx.firebaseapp.com",
  projectId: "cpx-tracker-xxxx",
  ...
};
```

이 값을 `public/app.js` 맨 위 `firebaseConfig` 에 붙여넣습니다.

> **이 값은 비밀이 아닙니다.** 웹앱을 열면 누구나 볼 수 있는 공개 식별자이고,
> 실제 접근 통제는 보안 규칙이 합니다. 그대로 커밋해도 됩니다.
> `apiKey` 와 `projectId` 는 3단계 워커 설정에도 씁니다.

### 1-5. 보안 규칙 붙여넣기
**Firestore Database → 규칙** 탭 → 편집기 내용을 전부 지우고
이 저장소의 [`firestore.rules`](firestore.rules) 내용을 그대로 붙여넣기 → **게시**.

### 1-6. 복합 색인 만들기 — 빠뜨리면 목록이 안 뜹니다

**Firestore Database → 색인 → 복합** 탭 → **색인 만들기**

| 항목 | 값 |
|---|---|
| 컬렉션 ID | `records` |
| 필드 1 | `uid` — 오름차순 |
| 필드 2 | `createdAt` — 내림차순 |
| 쿼리 범위 | 컬렉션 |

빌드에 몇 분 걸립니다. 상태가 "사용 설정됨"이 될 때까지 기다리세요.

> **단일 필드 예외는 만들 필요가 없습니다.** Firestore는 모든 필드를 자동 색인하고
> 색인 항목 하나는 7.5KiB가 상한이라, 긴 전사를 문자열 그대로 넣으면 쓰기가 거부됩니다.
> 원래는 콘솔에서 색인 예외를 만들어 피하는데, 콘솔 UI가 세 토글을 모두 끄는 걸
> 허용하지 않는 경우가 있습니다. 그래서 **긴 텍스트를 1500자씩 잘라 배열로 저장**하도록
> 코드에서 처리했습니다. 조각마다 색인이 잡히고 각 조각이 상한 아래라 예외가 필요 없습니다.
> 수동 콘솔 작업이 하나 줄어들어, 나중에 프로젝트를 다시 만들 때도 반복하지 않아도 됩니다.

### 1-7. 요금제는 Spark(무료) 그대로 두기
Blaze로 올리라는 안내가 보여도 **올리지 마세요.** Spark에서는 한도를 넘으면 요금이 청구되는 대신
기능이 멈춥니다. 이 프로젝트는 Cloud Functions를 안 쓰므로 Blaze가 필요 없습니다.

---

## 2. 설정값 채우기

| 파일 | 바꿀 것 |
|---|---|
| `public/app.js` | `firebaseConfig` — 1-4에서 복사한 값 |
| `public/app.js` | `MARKETPLACE` — 플러그인 GitHub 레포 (`아이디/cpx-marketplace`) |

---

## 3. 웹앱 올리기 — GitHub Pages

Firebase Hosting은 CLI가 있어야 하므로 쓰지 않습니다. GitHub Pages가 무료이고 Node도 필요 없습니다.

1. GitHub에서 레포를 만듭니다 (예: `cpx-tracker`, **Public**).
2. `public/` 폴더 안의 세 파일(`index.html`, `app.js`, `style.css`)을 레포 **최상단**에 올립니다.
   웹 UI에서 **Add file → Upload files** 로 드래그해도 되고, git을 써도 됩니다:

```bash
git init && git add . && git commit -m "CPX 기록판" && git branch -M main
```

3. 레포 **Settings → Pages** → Source를 **Deploy from a branch**, 브랜치 `main` / 폴더 `/ (root)` 로 저장.
4. 몇 분 뒤 `https://<아이디>.github.io/cpx-tracker/` 가 열립니다.

### 3-1. 승인된 도메인 추가 — 빠뜨리면 로그인이 안 됩니다

Firebase 콘솔 → **Authentication → Settings → 승인된 도메인** → **도메인 추가** →
`<아이디>.github.io` 입력.

이걸 안 하면 로그인 시 `auth/unauthorized-domain` 오류가 납니다.

> 드래그앤드롭이 더 편하면 **Cloudflare Pages**(Workers & Pages → Create → Pages →
> Upload assets)로 `public` 폴더를 통째로 올려도 됩니다. 이 경우 승인된 도메인에는
> `<프로젝트>.pages.dev` 를 추가하세요.

---

## 4. 데이터 구조

### `users/{uid}`
| 필드 | 용도 |
|---|---|
| `nickname`, `email` | 표시용 |
| `consentTranscript` | 문진 전사 저장 동의 여부. 워커가 이 값을 보고 전사를 버릴지 결정 |
| `tokenVersion` | 연결 코드 무효화용. 올리면 이전 코드가 거부됨 |

### `records/{id}`
| 필드 | 용도 |
|---|---|
| `uid`, `source` | 소유자, `manual`(직접 입력) 또는 `plugin`(자동) |
| `topic`, `totalScore`, `historyScore`, `peScore`, `ppiScore`, `grade`, `note` | 점수와 총평 |
| `evaluationChunks` | 채점 결과 원문. 1500자씩 잘린 문자열 배열 (최대 50조각) |
| `transcriptChunks` | 문진 전사. 동의한 경우에만 채워짐. 1500자씩 잘린 배열 (최대 500조각) |
| `transcriptTruncated` | 전사가 잘렸는지 |

`*Chunks` 는 웹앱에서 `join("")` 으로 다시 이어붙여 보여줍니다.
긴 문자열을 그대로 넣으면 색인 항목 상한(7.5KiB)에 걸려 쓰기가 실패하기 때문에 조각내어 저장합니다.

---

## 5. 한계

- 기록 **수정**은 막혀 있습니다(삭제만 가능). 규칙에서 `allow update: if false`.
- 대시보드가 `onSnapshot` 실시간 구독이라 유저가 수백 명대로 늘면 하루 5만 읽기 한도에
  먼저 닿습니다. 그때는 1회성 조회 + 페이지네이션으로 바꾸세요.
- 계정 삭제 기능은 아직 없습니다. 요청이 오면 콘솔에서 직접 지워야 합니다.
- 규칙과 색인을 콘솔에서 손으로 넣었다면, 이 저장소의 `firestore.rules` /
  `firestore.indexes.json` 을 고칠 때 **콘솔에도 같이 반영**해야 합니다.
