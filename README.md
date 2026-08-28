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

| 무엇을 | 어떻게 |
|---|---|
| Firestore 규칙·색인 | `firebase deploy --only firestore` — CLI 설치 완료 (아래 참고) |
| 웹앱 호스팅 | **GitHub Pages** — `docs/` 를 푸시하면 자동. Firebase Hosting 은 안 씁니다 |
| Cloudflare 워커 | Cloudflare 대시보드의 온라인 편집기에 붙여넣기 (Wrangler 미설치) |

워커만 여전히 손으로 올립니다. 나머지 둘은 명령으로 끝납니다.

### 규칙·색인은 CLI로 배포합니다 (2026-08-28 설정)

작업 PC에는 firebase-tools 를 깔아뒀습니다. 콘솔에 붙여넣지 않고 명령 한 줄로 배포합니다.

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

이 저장소 최상단에서 실행하면 `.firebaserc` 의 프로젝트(`cpx-tracker`)로 갑니다.
규칙만/색인만 따로 올리려면 `--only firestore:rules` 또는 `--only firestore:indexes`.

처음 한 번은 로그인이 필요합니다 (브라우저가 열립니다):

```bash
firebase login
```

호스팅은 계속 GitHub Pages 를 씁니다 — `firebase deploy --only hosting` 은 쓰지 마세요.
두 곳에 같은 사이트가 생겨 어느 쪽이 최신인지 헷갈립니다.

> 설치 위치는 `~/.firebase-cli/` 이고 `~/bin/firebase` 래퍼로 부릅니다.
> 전역 설치(`npm i -g`)는 npm prefix 가 Program Files 라 관리자 권한이 필요해서 피했습니다.
> 이 PC의 node 는 한컴 번들 경로에만 있어서 래퍼가 PATH 를 직접 잡아줍니다.
> 다른 PC에서는 node 를 깔고 `npm i -g firebase-tools` 하면 그만입니다.

아래 콘솔 수동 절차(1-5, 1-6)는 CLI를 못 쓸 때의 대안으로 남겨둡니다.
콘솔에서 손으로 고쳤다면 이 저장소의 `firestore.rules` / `firestore.indexes.json` 에도 같은 내용을 반영하세요.

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

이 값을 `docs/app.js` 맨 위 `firebaseConfig` 에 붙여넣습니다.

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
| `docs/app.js` | `firebaseConfig` — 1-4에서 복사한 값 |
| `docs/app.js` | `MARKETPLACE` — 플러그인 GitHub 레포 (`아이디/cpx-marketplace`) |
| `docs/app.js` | `OWNER_UID` — 관리자 uid. `firestore.rules` 의 `ownerUid()` 와 같아야 합니다 |

---

## 3. 웹앱 올리기 — GitHub Pages

Firebase Hosting은 CLI가 있어야 하므로 쓰지 않습니다. GitHub Pages가 무료이고 Node도 필요 없습니다.

1. GitHub에서 레포를 만듭니다 (예: `cpx-tracker`, **Public**).
2. `docs/` 폴더째 올립니다 — `index.html`, `style.css`, `app.js`, `analytics.js`, `export.js`, `topics.js` 여섯 파일입니다.
   웹 UI에서 **Add file → Upload files** 로 드래그해도 되고, git을 써도 됩니다:

```bash
git init && git add . && git commit -m "CPX 기록판" && git branch -M main
```

3. 레포 **Settings → Pages** → Source를 **Deploy from a branch**, 브랜치 `main` / 폴더 `/docs` 로 저장.
4. 몇 분 뒤 `https://<아이디>.github.io/cpx-tracker/` 가 열립니다.

### 3-1. 승인된 도메인 추가 — 빠뜨리면 로그인이 안 됩니다

Firebase 콘솔 → **Authentication → Settings → 승인된 도메인** → **도메인 추가** →
`<아이디>.github.io` 입력.

이걸 안 하면 로그인 시 `auth/unauthorized-domain` 오류가 납니다.

> 드래그앤드롭이 더 편하면 **Cloudflare Pages**(Workers & Pages → Create → Pages →
> Upload assets)로 `docs` 폴더를 통째로 올려도 됩니다. 이 경우 승인된 도메인에는
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
| `uid`, `source` | 소유자, `plugin`(자동 업로드). 2026-08-29 이전 기록에는 `manual`(웹에서 직접 입력)이 섞여 있습니다 |
| `topic`, `totalScore`, `historyScore`, `peScore`, `ppiScore`, `grade`, `note` | 점수와 총평 |
| `evaluationChunks` | 채점 결과 원문. 1500자씩 잘린 문자열 배열 (최대 50조각) |
| `transcriptChunks` | 문진 전사. 동의한 경우에만 채워짐. 1500자씩 잘린 배열 (최대 500조각) |
| `transcriptTruncated` | 전사가 잘렸는지 |

`*Chunks` 는 웹앱에서 `join("")` 으로 다시 이어붙여 보여줍니다.
긴 문자열을 그대로 넣으면 색인 항목 상한(7.5KiB)에 걸려 쓰기가 실패하기 때문에 조각내어 저장합니다.

---

### 웹앱 파일 구성

| 파일 | 하는 일 |
|---|---|
| `docs/index.html` | 화면 뼈대. 대시보드는 내 기록 / 분석 / Claude Code 연결 / 설정 (+관리자) 탭 |
| `docs/app.js` | Firebase 인증·구독, 기록 표, 검색·필터·정렬, 기록 상세 모달, 테마 토글, 관리자 화면 |

웹앱은 이제 기록을 만들지 않고 읽고 지우기만 합니다. "직접 입력하기" 폼은 2026-08-29 에 뺐습니다
— 기록은 전부 플러그인이 올립니다. `firestore.rules` 는 여전히 `source` 로 `manual` 도 받는데,
지난 기록이 그 값을 갖고 있어서 그대로 뒀습니다.
| `docs/analytics.js` | 분석 탭 — 영역별 성취율, 케이스별 점수(검색·범위·정렬, 펼치면 회차와 성적 추이) |
| `docs/export.js` | 기록 한 건을 마크다운으로 바꾸고 파일로 내려주기 |
| `docs/topics.js` | 케이스 뱅크 목록(58개)과 이름 맞추기 |
| `docs/style.css` | 색 토큰(라이트/다크), 컴포넌트, 좁은 화면 대응 |

`analytics.js` 는 Firestore 를 직접 만지지 않습니다. `app.js` 가 넘겨준 기록 배열만 받아 계산하므로,
집계 로직은 브라우저 없이도 노드에서 그대로 불러 검증할 수 있습니다.

분석 탭은 기록 탭의 필터를 타지 않고 항상 전체 기록으로 그립니다.

케이스별 점수 표는 케이스 뱅크 58개를 전부 한 줄씩 냅니다. 해본 케이스는 누르면 회차별 점수가
펼쳐지고 회차마다 "면담 보기" 로 채점 결과와 문진 전사를 볼 수 있습니다. 안 해본 케이스는
"미실시" 로 흐리게 한 줄만 남습니다 — 커버리지를 따로 두지 않고 이 표가 겸합니다.
검색창에 케이스 이름을 넣으면 한 건만 띄울 수 있고, 표기가 조금 달라도(공백·괄호·슬래시) 찾습니다.
검색창을 누르면 58개 케이스 이름이 선택지로 뜹니다(`<datalist>`).

### 케이스를 펼치면 회차와 성적 추이가 나옵니다

왼쪽에 회차별 점수(각 회차마다 "면담 보기"), 오른쪽에 그 케이스의 성적 추이입니다.
추이는 그래프가 아니라 회차별 막대입니다 — 한 케이스의 회차 수는 보통 한 자릿수라
선 그래프로 그릴 만한 양이 아니고, 막대 길이와 "첫 회 58 → 최근 88 (+30)" 한 줄이면
방향이 읽힙니다. 1회뿐이면 그렇다고 적습니다.

한때 여기에 "자주 놓친 항목"(채점 원문에서 X·△ 를 긁어 집계)이 있었습니다. 2026-08-29 에
성적 추이로 바꾸면서 `docs/evaluation.js` 와 함께 뺐습니다 — 되살리려면 git 이력에 있습니다.
그 기능은 채점 원문의 표 형식에 기대는 반면 추이는 점수 필드만 쓰므로, 형식이 흔들려도 깨지지 않습니다.

### 면담 내려받기 — .md 와 PDF

기록 상세 모달 오른쪽 위에 `.md` 와 `PDF` 버튼이 있습니다.

`.md` 는 `CPX_가슴통증_2026-08-29.md` 로 바로 저장됩니다. 제목·일시·점수·채점 결과·문진 전사가
한 파일에 담깁니다. 전사는 줄바꿈이 곧 뜻이라 코드 블록에 넣는데, 전사 안에 백틱 울타리가 있으면
블록이 거기서 닫히므로 가장 긴 것보다 한 칸 긴 울타리를 씁니다. 점수 전달용 `cpx-record` 블록은 뺍니다.

`PDF` 는 브라우저 인쇄 대화상자를 엽니다 — 거기서 대상을 "PDF로 저장"으로 고르면 됩니다.
jsPDF 류로 직접 만들지 않은 이유는 한글입니다. 그런 라이브러리는 한글 폰트를 통째로 실어야 하고
(수 MB) 안 실으면 글자가 깨집니다. 인쇄는 의존성이 없고, 글자가 선택·검색되는 PDF 가 나옵니다.
대신 저장 위치와 파일명을 사용자가 고르는 단계가 하나 낍니다.

인쇄용 규칙은 `style.css` 의 `@media print` 에 있습니다. 화면에서는 채점 결과와 문진 전사가
탭으로 갈려 있지만 인쇄물에는 둘 다 담깁니다 — `app.js` 가 인쇄 직전 `<html>` 에 `.printing` 을
붙였다가 끝나면 뗍니다. 숨은 탭의 `.hidden`(`display:none !important`)을 이기려고
`#paneScript.hidden` 처럼 id 를 끼워 특이도를 올려 뒀으니, 선택자를 줄이면 인쇄가 깨집니다.

"면담 보기" 가 띄우는 모달은 기록 탭이 쓰는 것과 같은 것입니다. `app.js` 가
`renderAnalytics(rows, { onOpenRecord })` 로 여는 함수를 넘겨주므로 `analytics.js` 는
모달 마크업을 몰라도 됩니다.

### `docs/topics.js` 는 플러그인 쪽 목록과 짝입니다

커버리지는 기록의 `topic` 문자열을 케이스 뱅크 이름에 맞춰 셉니다. 그 목록이 `docs/topics.js` 의
`TOPICS` 이고, 원본은 플러그인의 `skills/start/refs/topics.md` 입니다.
**스킬에서 케이스를 더하거나 이름을 바꾸면 `topics.js` 도 같이 고쳐야** 합니다.
안 고치면 그 기록은 커버리지에서 빠지고, 분석 탭 커버리지 패널 아래에
"케이스 뱅크에서 이름을 찾지 못한 기록" 으로 이름이 그대로 표시됩니다 — 어긋난 걸 알아채라고 남긴 표시입니다.

표기가 조금 흔들리는 정도(공백·괄호·슬래시 차이)는 자동으로 흡수하고, 그걸로도 안 되는 흔한 다른 이름은
각 항목의 `aliases` 에 넣어 같은 케이스로 셉니다 (예: `흉통` → `가슴통증`).

### 색

색은 전부 `style.css` 맨 위 CSS 변수입니다. 라이트 값을 `:root` 에 두고, OS 다크 설정과
사용자 토글(`html[data-theme]`) 두 경우에 다시 덮어씁니다. 화면 밝기는 자동 / 밝게 / 어둡게 세 가지로
돌아가며 `localStorage` 에 남습니다.

`--viz-1` ~ `--viz-4` 는 점수 밴드(<70 / 70 / 80 / 90+)에 쓰는 단일 색상 순서 램프이고,
두 모드 모두 명도 단조·단계 간격·배경 대비 검사를 통과시킨 값입니다. 눈대중으로 바꾸지 마세요.

## 5. 한계

- 기록 **수정**은 막혀 있습니다(삭제만 가능). 규칙에서 `allow update: if false`.
- 대시보드가 `onSnapshot` 실시간 구독이라 유저가 수백 명대로 늘면 하루 5만 읽기 한도에
  먼저 닿습니다. 그때는 1회성 조회 + 페이지네이션으로 바꾸세요.
- 계정 삭제 기능은 아직 없습니다. 요청이 오면 콘솔에서 직접 지워야 합니다.
- 규칙과 색인을 콘솔에서 손으로 넣었다면, 이 저장소의 `firestore.rules` /
  `firestore.indexes.json` 을 고칠 때 **콘솔에도 같이 반영**해야 합니다.
