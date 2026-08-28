// ============================================================
// 설정 — 배포 전에 아래 두 곳을 본인 값으로 교체하세요.
//   1) firebaseConfig : Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)
//   2) MARKETPLACE    : 플러그인을 올린 GitHub 레포 (owner/repo)
// firebaseConfig 는 비밀값이 아닙니다. 접근 통제는 firestore.rules 가 합니다.
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyD1rN6_CvmmjvV40kRGD37f7TZ2ZwNZpqA",
  authDomain: "cpx-tracker.firebaseapp.com",
  projectId: "cpx-tracker",
  storageBucket: "cpx-tracker.firebasestorage.app",
  messagingSenderId: "454560324678",
  appId: "1:454560324678:web:84f872ad8d63c62d37fe47",
};

const MARKETPLACE = "raphael4040-ash/cpx-marketplace";

// 이 기록판의 관리자 uid. firestore.rules 의 ownerUid() 와 반드시 같아야 한다.
const OWNER_UID = "S4b2Zqzff2XHNznL1Wcq6RiZVGv1";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import { renderAnalytics } from "./analytics.js";
import { TOPICS, matchTopic } from "./topics.js";
import {
  joinChunks,
  fmtDateTime,
  detailFilename,
  recordToMarkdown,
  downloadText,
} from "./export.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);

// ---------- DOM ----------
const authSection = $("authSection");
const dashboardSection = $("dashboardSection");
const navAuthed = $("navAuthed");
const whoName = $("whoName");

const tabLogin = $("tabLogin");
const tabRegister = $("tabRegister");
const loginForm = $("loginForm");
const registerForm = $("registerForm");
const loginErr = $("loginErr");
const registerErr = $("registerErr");

const recordBody = $("recordBody");
const recordTable = $("recordTable");
const emptyMsg = $("emptyMsg");
const noMatchMsg = $("noMatchMsg");
const filtersBar = $("filters");
const recordCount = $("recordCount");
const avgScore = $("avgScore");

const setConsent = $("setConsent");
const settingsSaved = $("settingsSaved");

const pendingSection = $("pendingSection");
const tabAdmin = $("tabAdmin");
const viewAdmin = $("viewAdmin");
// 관리자가 아니면 관리자 UI 를 숨기는 것이 아니라 DOM 에서 통째로 떼낸다.
// 다시 붙일 수 있도록 원래 부모를 미리 기억해둔다 (둘 다 부모의 마지막 자식이다).
const adminNavHost = tabAdmin.parentElement;
const adminViewHost = viewAdmin.parentElement;
const setRequireApproval = $("setRequireApproval");
const adminSaved = $("adminSaved");

let unsubscribeRecords = null;
let currentRows = [];
let profile = null; // users/{uid} 캐시
let appConfig = { requireApproval: false }; // config/app 캐시
let unsubscribeUsers = null;

// ---------- 로그인/회원가입 탭 ----------
tabLogin.addEventListener("click", () => {
  tabLogin.classList.add("active");
  tabRegister.classList.remove("active");
  loginForm.classList.remove("hidden");
  registerForm.classList.add("hidden");
});
tabRegister.addEventListener("click", () => {
  tabRegister.classList.add("active");
  tabLogin.classList.remove("active");
  registerForm.classList.remove("hidden");
  loginForm.classList.add("hidden");
});

// ---------- 대시보드 탭 ----------
const views = {
  records: $("viewRecords"),
  analysis: $("viewAnalysis"),
  pair: $("viewPair"),
  settings: $("viewSettings"),
};
document.querySelectorAll(".subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".subtab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    for (const [name, el] of Object.entries(views)) {
      el.classList.toggle("hidden", name !== btn.dataset.view);
    }
    if (btn.dataset.view === "analysis") drawAnalytics();
  });
});

// ---------- 테마 ----------
// 셋 중 하나다: light / dark / (저장값 없음 = OS 설정 따라감).
const btnTheme = $("btnTheme");

function currentTheme() {
  return document.documentElement.dataset.theme || "auto";
}
function applyTheme(next) {
  if (next === "auto") {
    delete document.documentElement.dataset.theme;
    localStorage.removeItem("cpx-theme");
  } else {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("cpx-theme", next);
  }
  const label = { auto: "자동", light: "밝게", dark: "어둡게" }[next];
  btnTheme.textContent = { auto: "◐", light: "☀", dark: "☾" }[next];
  btnTheme.title = `화면: ${label} (눌러서 전환)`;
}
btnTheme.addEventListener("click", () => {
  const order = ["auto", "light", "dark"];
  applyTheme(order[(order.indexOf(currentTheme()) + 1) % order.length]);
});
applyTheme(currentTheme());


// ---------- 인증 ----------
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginErr.textContent = "";
  try {
    await signInWithEmailAndPassword(
      auth,
      $("loginEmail").value.trim(),
      $("loginPassword").value
    );
  } catch {
    loginErr.textContent = "로그인 실패: 이메일 또는 비밀번호를 확인하세요.";
  }
});

registerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerErr.textContent = "";
  const nickname = $("registerNickname").value.trim();
  if (!nickname) {
    registerErr.textContent = "닉네임을 입력해주세요.";
    return;
  }
  try {
    const cred = await createUserWithEmailAndPassword(
      auth,
      $("registerEmail").value.trim(),
      $("registerPassword").value
    );
    await updateProfile(cred.user, { displayName: nickname });
    await setDoc(doc(db, "users", cred.user.uid), {
      nickname,
      email: cred.user.email,
      consentTranscript: $("registerConsent").checked,
      consentAt: serverTimestamp(),
      tokenVersion: 1,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    registerErr.textContent = `가입 실패: ${err.code || err.message}`;
  }
});

$("btnLogout").addEventListener("click", async (e) => {
  e.preventDefault();
  await signOut(auth);
});

// ---------- 로그인 상태 ----------
onAuthStateChanged(auth, async (user) => {
  if (unsubscribeRecords) {
    unsubscribeRecords();
    unsubscribeRecords = null;
  }
  if (unsubscribeUsers) {
    unsubscribeUsers();
    unsubscribeUsers = null;
  }
  if (!user) {
    profile = null;
    authSection.classList.remove("hidden");
    dashboardSection.classList.add("hidden");
    pendingSection.classList.add("hidden");
    navAuthed.classList.add("hidden");
    return;
  }

  authSection.classList.add("hidden");
  navAuthed.classList.remove("hidden");
  whoName.textContent = user.displayName || user.email;

  profile = await loadProfile(user);
  appConfig = await loadAppConfig();

  const isAdmin = user.uid === OWNER_UID;
  const blocked = !isAdmin && appConfig.requireApproval && profile.approved !== true;

  // 승인 대기 중이면 대시보드 자체를 띄우지 않는다. 기록 읽기도 시작하지 않는다.
  if (blocked) {
    dashboardSection.classList.add("hidden");
    pendingSection.classList.remove("hidden");
    $("pendingWho").textContent = `${user.email} 계정으로 신청되어 있습니다.`;
    return;
  }

  pendingSection.classList.add("hidden");
  dashboardSection.classList.remove("hidden");

  $("installCmd").textContent = `claude plugin marketplace add ${MARKETPLACE}`;
  setConsent.checked = profile.consentTranscript === true;

  setAdminUi(isAdmin);
  if (isAdmin) {
    setRequireApproval.checked = appConfig.requireApproval === true;
    watchUsers();
  }

  watchRecords(user.uid);
});

// users 문서가 없는 계정(구버전 가입자 등)은 기본값으로 만들어 준다.
async function loadProfile(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return snap.data();
  const fresh = {
    nickname: user.displayName || "",
    email: user.email,
    consentTranscript: false, // 명시적 동의가 없으면 전사를 저장하지 않는다
    tokenVersion: 1,
    createdAt: serverTimestamp(),
  };
  await setDoc(ref, fresh);
  return fresh;
}

// ---------- 설정 ----------
setConsent.addEventListener("change", async () => {
  const user = auth.currentUser;
  if (!user) return;
  await setDoc(
    doc(db, "users", user.uid),
    { consentTranscript: setConsent.checked, consentAt: serverTimestamp() },
    { merge: true }
  );
  profile.consentTranscript = setConsent.checked;
  settingsSaved.classList.remove("hidden");
  setTimeout(() => settingsSaved.classList.add("hidden"), 2000);
});

$("btnRevoke").addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;
  if (!confirm("발급한 연결 코드를 모두 무효화할까요? 연결된 기기의 자동 업로드가 멈춥니다.")) return;
  const next = (profile.tokenVersion || 1) + 1;
  await setDoc(doc(db, "users", user.uid), { tokenVersion: next }, { merge: true });
  profile.tokenVersion = next;
  $("pairToken").value = "";
  $("pairActions").classList.add("hidden");
  alert("무효화했습니다. Claude Code 연결 탭에서 코드를 새로 발급하세요.");
});

// ---------- 페어링 코드 ----------
$("btnMakeToken").addEventListener("click", () => {
  const user = auth.currentUser;
  if (!user) return;
  if (!user.refreshToken) {
    alert("연결 코드를 만들 수 없습니다. 로그아웃 후 다시 로그인해주세요.");
    return;
  }
  const payload = {
    v: 1,
    uid: user.uid,
    rt: user.refreshToken,
    tv: profile.tokenVersion || 1,
  };
  $("pairToken").value = b64url(JSON.stringify(payload));
  $("pairActions").classList.remove("hidden");
});

$("btnCopyToken").addEventListener("click", async () => {
  const el = $("pairToken");
  if (!el.value) return;
  try {
    await navigator.clipboard.writeText(el.value);
  } catch {
    el.select(); // 클립보드 권한이 없는 브라우저 대비
    document.execCommand("copy");
  }
  $("copiedMsg").classList.remove("hidden");
  setTimeout(() => $("copiedMsg").classList.add("hidden"), 1500);
});

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_");
}

// ---------- 기록 구독 ----------
function watchRecords(uid) {
  const q = query(
    collection(db, "records"),
    where("uid", "==", uid),
    orderBy("createdAt", "desc")
  );
  unsubscribeRecords = onSnapshot(q, (snapshot) => {
    currentRows = [];
    snapshot.forEach((d) => currentRows.push({ id: d.id, ...d.data() }));
    refreshViews();
  });
}

// 기록이 바뀌면 표·필터 선택지·분석을 한꺼번에 맞춘다.
function refreshViews() {
  syncTopicFilter();
  renderRecords(applyFilters(currentRows));
  if (!views.analysis.classList.contains("hidden")) drawAnalytics();
}

// 분석 탭은 필터를 타지 않는다 — 전체 기록으로 그린다.
// 회차별 "면담 보기" 는 기록 탭과 같은 상세 모달을 쓰므로 여는 함수를 넘겨준다.
function drawAnalytics() {
  renderAnalytics(currentRows, { onOpenRecord: openDetail });
}

// ---------- 검색 · 필터 · 정렬 ----------
const fltQuery = $("fltQuery");
const fltTopic = $("fltTopic");
const fltPeriod = $("fltPeriod");
const fltSort = $("fltSort");
const fltReset = $("fltReset");

for (const c of [fltQuery, fltTopic, fltPeriod, fltSort]) {
  c.addEventListener("input", () => renderRecords(applyFilters(currentRows)));
}
fltReset.addEventListener("click", () => {
  fltQuery.value = "";
  fltTopic.value = "";
  fltPeriod.value = "0";
  fltSort.value = "new";
  renderRecords(applyFilters(currentRows));
});

// 주제 드롭다운에는 실제로 기록이 있는 주제만 넣는다. 케이스 뱅크 순서를 따르고,
// 뱅크에 없는 이름(직접 입력 등)은 뒤에 따로 붙인다.
function syncTopicFilter() {
  const seen = new Set(currentRows.map((r) => (r.topic || "").trim()).filter(Boolean));
  const known = TOPICS.filter((t) => [...seen].some((s) => matchTopic(s)?.name === t.name)).map((t) => t.name);
  const extra = [...seen].filter((s) => !matchTopic(s)).sort();
  const opts = [...known, ...extra];

  const prev = fltTopic.value;
  fltTopic.innerHTML =
    '<option value="">모든 주제</option>' +
    opts.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
  // 고르고 있던 주제가 아직 목록에 있으면 선택을 유지한다.
  fltTopic.value = opts.includes(prev) ? prev : "";
}

function applyFilters(rows) {
  const q = fltQuery.value.trim().toLowerCase();
  const topic = fltTopic.value;
  const days = parseInt(fltPeriod.value, 10) || 0;
  const cutoff = days ? Date.now() - days * 86400000 : 0;

  let out = rows.filter((r) => {
    if (topic) {
      const raw = (r.topic || "").trim();
      const same = matchTopic(raw)?.name === matchTopic(topic)?.name;
      if (!(raw === topic || (matchTopic(topic) && same))) return false;
    }
    if (cutoff) {
      const at = r.createdAt?.seconds ? r.createdAt.seconds * 1000 : 0;
      // 서버 타임스탬프가 아직 안 붙은 새 기록은 거르지 않는다.
      if (at && at < cutoff) return false;
    }
    if (q) {
      const hay = `${r.topic || ""} ${r.note || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const at = (r) => r.createdAt?.seconds || 0;
  const sc = (r) => (typeof r.totalScore === "number" ? r.totalScore : -1);
  const sorters = {
    new: (a, b) => at(b) - at(a),
    old: (a, b) => at(a) - at(b),
    high: (a, b) => sc(b) - sc(a) || at(b) - at(a),
    low: (a, b) => sc(a) - sc(b) || at(b) - at(a),
  };
  out = [...out].sort(sorters[fltSort.value] || sorters.new);

  const filtering = Boolean(q || topic || days || fltSort.value !== "new");
  fltReset.classList.toggle("hidden", !filtering);
  return out;
}

function renderRecords(rows) {
  const total = currentRows.length;
  const filtered = rows.length !== total;
  recordCount.textContent = filtered ? `${rows.length} / ${total}` : total;

  // 기록이 아예 없는 것과, 있는데 조건에 안 걸린 것은 다른 안내를 낸다.
  emptyMsg.classList.toggle("hidden", total !== 0);
  noMatchMsg.classList.toggle("hidden", !(total > 0 && rows.length === 0));
  filtersBar.classList.toggle("hidden", total === 0);

  if (rows.length === 0) {
    recordTable.classList.add("hidden");
    avgScore.textContent = "";
    recordBody.innerHTML = "";
    return;
  }

  recordTable.classList.remove("hidden");

  const scored = rows.filter((r) => typeof r.totalScore === "number");
  avgScore.textContent = scored.length
    ? `${filtered ? "선택 범위 " : ""}평균 총점: ${(
        scored.reduce((s, r) => s + r.totalScore, 0) / scored.length
      ).toFixed(1)}점`
    : "";

  recordBody.innerHTML = "";
  for (const r of rows) {
    const dash = (v) => (typeof v === "number" ? v : "-");
    const hasDetail = Boolean(
      r.evaluationChunks?.length || r.transcriptChunks?.length || r.evaluationText || r.transcript
    );
    const tr = document.createElement("tr");
    // data-label 은 좁은 화면에서 표가 카드로 접힐 때 각 칸의 이름표로 쓰인다.
    tr.innerHTML = `
      <td data-label="날짜">${fmtDateTime(r.createdAt)}</td>
      <td data-label="주제">${escapeHtml(r.topic || "")}${r.source === "plugin" ? '<span class="pill">자동</span>' : ""}</td>
      <td data-label="총점" class="score">${dash(r.totalScore)}</td>
      <td data-label="병력">${dash(r.historyScore)}</td>
      <td data-label="진찰">${dash(r.peScore)}</td>
      <td data-label="PPI">${dash(r.ppiScore)}</td>
      <td data-label="총평" class="note">${escapeHtml(r.note || "")}</td>
      <td class="actions">${hasDetail ? '<button class="btn ghost small js-detail">보기</button>' : ""}<button class="btn ghost small js-del">삭제</button></td>
    `;
    const detailBtn = tr.querySelector(".js-detail");
    if (detailBtn) detailBtn.addEventListener("click", () => openDetail(r));
    tr.querySelector(".js-del").addEventListener("click", () => deleteRecord(r.id));
    recordBody.appendChild(tr);
  }
}

async function deleteRecord(id) {
  if (!confirm("이 기록을 삭제할까요? 저장된 전사도 함께 지워집니다.")) return;
  await deleteDoc(doc(db, "records", id));
}

// ---------- 상세 보기 ----------
const backdrop = $("detailBackdrop");
const detailMeta = $("detailMeta");
document.querySelectorAll(".dtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".dtab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $("paneEval").classList.toggle("hidden", btn.dataset.pane !== "eval");
    $("paneScript").classList.toggle("hidden", btn.dataset.pane !== "script");
  });
});
$("btnCloseDetail").addEventListener("click", closeDetail);
backdrop.addEventListener("click", (e) => {
  if (e.target === backdrop) closeDetail();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});

// 모달이 지금 띄우고 있는 기록. 내려받기 버튼이 이것을 쓴다.
let currentDetail = null;

function openDetail(r) {
  currentDetail = r;
  $("detailTitle").textContent = `${r.topic || "무작위"} · ${fmtDateTime(r.createdAt)}`;

  const evalText = joinChunks(r.evaluationChunks, r.evaluationText);
  $("paneEval").innerHTML = evalText
    ? renderMarkdown(evalText)
    : '<p class="muted">(채점 결과 원문이 저장되지 않은 기록입니다)</p>';

  const script = joinChunks(r.transcriptChunks, r.transcript);
  $("paneScript").textContent = script
    ? script + (r.transcriptTruncated ? "\n\n— 앞부분이 길어 잘렸습니다 —" : "")
    : "(문진 전사가 저장되지 않은 기록입니다)";

  const bits = [];
  if (typeof r.totalScore === "number") bits.push(`총점 ${r.totalScore}`);
  const sect = [
    ["병력", r.historyScore],
    ["진찰", r.peScore],
    ["PPI", r.ppiScore],
  ].filter(([, v]) => typeof v === "number");
  if (sect.length) bits.push(sect.map(([n, v]) => `${n} ${v}`).join(" · "));
  if (r.grade) bits.push(`등급 ${r.grade}`);
  detailMeta.textContent = bits.join("  |  ");
  detailMeta.classList.toggle("hidden", bits.length === 0);

  document.querySelectorAll(".dtab")[0].click();
  backdrop.classList.remove("hidden");
}

function closeDetail() {
  backdrop.classList.add("hidden");
}



// ---------- 면담 내려받기 ----------
// .md 는 파일로 바로 저장한다. PDF 는 브라우저 인쇄로 넘긴다 —
// 만드는 쪽 설명은 export.js 와 style.css 의 @media print 에 있다.

$("btnSaveMd").addEventListener("click", () => {
  if (!currentDetail) return;
  downloadText(detailFilename(currentDetail, "md"), recordToMarkdown(currentDetail), "text/markdown");
});

$("btnSavePdf").addEventListener("click", () => {
  if (!currentDetail) return;
  // 인쇄물에는 채점 결과와 문진 전사를 함께 담는다 (style.css 의 .printing 규칙).
  document.documentElement.classList.add("printing");
  const done = () => {
    document.documentElement.classList.remove("printing");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
  // afterprint 를 안 쏘는 브라우저 대비.
  setTimeout(done, 3000);
});

// ---------- 관리자: 가입 승인제 ----------

// 관리자가 아닌 계정에서는 탭도 본문도 문서에 남지 않는다.
function setAdminUi(on) {
  if (on) {
    if (!tabAdmin.isConnected) adminNavHost.appendChild(tabAdmin);
    if (!viewAdmin.isConnected) adminViewHost.appendChild(viewAdmin);
    tabAdmin.classList.remove("hidden");
    views.admin = viewAdmin;
    return;
  }
  tabAdmin.remove();
  viewAdmin.remove();
  delete views.admin;
}
// 관리자 uid 는 firestore.rules 의 ownerUid() 와 반드시 같아야 한다.
// 규칙이 실제 통제를 하고, 여기 화면은 그 상태를 보여줄 뿐이다.

async function loadAppConfig() {
  try {
    const snap = await getDoc(doc(db, "config", "app"));
    return snap.exists() ? snap.data() : { requireApproval: false };
  } catch {
    // 못 읽으면 꺼진 것으로 본다 — 설정을 못 읽었다고 멀쩡한 유저를 잠그지 않는다.
    return { requireApproval: false };
  }
}

setRequireApproval.addEventListener("change", async () => {
  const on = setRequireApproval.checked;
  try {
    await setDoc(
      doc(db, "config", "app"),
      { requireApproval: on, updatedAt: serverTimestamp() },
      { merge: true }
    );
    appConfig.requireApproval = on;
    adminSaved.textContent = on
      ? "켰습니다 · 승인받지 않은 계정은 이제 기록을 남길 수 없습니다"
      : "껐습니다 · 가입한 누구나 바로 이용할 수 있습니다";
    adminSaved.classList.remove("hidden");
    setTimeout(() => adminSaved.classList.add("hidden"), 3000);
  } catch {
    setRequireApproval.checked = !on;
    alert(
      "설정을 저장하지 못했습니다.\n" +
        "Firestore 규칙이 아직 배포되지 않았을 가능성이 큽니다 — " +
        "Firebase 콘솔 > Firestore Database > 규칙 에서 firestore.rules 를 게시해주세요."
    );
  }
});

function watchUsers() {
  if (unsubscribeUsers) unsubscribeUsers();
  unsubscribeUsers = onSnapshot(collection(db, "users"), (snapshot) => {
    const rows = [];
    snapshot.forEach((d) => rows.push({ uid: d.id, ...d.data() }));
    // 대기 중인 계정을 위로, 그다음 최근 가입 순.
    rows.sort((a, b) => {
      const wait = (u) => (u.uid !== OWNER_UID && u.approved !== true ? 0 : 1);
      if (wait(a) !== wait(b)) return wait(a) - wait(b);
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    });
    renderUsers(rows);
  });
}

function renderUsers(rows) {
  $("adminCount").textContent = rows.length;
  const table = $("adminTable");
  const empty = $("adminEmpty");
  const body = $("adminBody");

  empty.classList.toggle("hidden", rows.length > 0);
  table.classList.toggle("hidden", rows.length === 0);
  body.innerHTML = "";

  for (const u of rows) {
    const isAdmin = u.uid === OWNER_UID;
    const approved = isAdmin || u.approved === true;
    const pill = isAdmin
      ? '<span class="status-pill on">관리자</span>'
      : approved
      ? '<span class="status-pill on">승인됨</span>'
      : '<span class="status-pill wait">대기 중</span>';

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(u.nickname || "")}</td>
      <td>${escapeHtml(u.email || "")}</td>
      <td>${fmtDateTime(u.createdAt)}</td>
      <td>${pill}</td>
      <td>${
        isAdmin
          ? ""
          : `<button class="btn ghost small js-approve">${approved ? "승인 취소" : "승인"}</button>`
      }</td>
    `;
    const btn = tr.querySelector(".js-approve");
    if (btn) btn.addEventListener("click", () => setApproved(u, !approved));
    body.appendChild(tr);
  }
}

async function setApproved(u, next) {
  const who = u.nickname || u.email || u.uid;
  if (!next && !confirm(`${who} 계정의 승인을 취소할까요? 이후 업로드가 막힙니다.`)) return;
  try {
    await setDoc(
      doc(db, "users", u.uid),
      { approved: next, approvedAt: next ? serverTimestamp() : null },
      { merge: true }
    );
  } catch {
    alert(
      "변경하지 못했습니다.\n" +
        "Firestore 규칙이 아직 배포되지 않았을 가능성이 큽니다."
    );
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// 채점 결과는 마크다운(제목·표·목록)으로 저장된다. 외부 라이브러리 없이 필요한
// 문법만 직접 렌더링한다. 모든 조각을 escapeHtml 로 먼저 통과시키므로 저장된
// 내용이 HTML 로 실행될 여지는 없다.
function renderMarkdown(md) {
  const src = String(md || "")
    .replace(/\r\n?/g, "\n")
    // 기록 블록은 점수를 저장하기 위한 것이라 화면에 보여줄 필요가 없다.
    .replace(/```cpx-record[\s\S]*?```/g, "");

  const lines = src.split("\n");
  const html = [];
  let para = [];
  let list = null;

  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((i) => `<li>${inline(i)}</li>`).join("");
      html.push(`<${list.tag}>${items}</${list.tag}>`);
      list = null;
    }
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l || "");
  const cells = (l) =>
    l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 표 = 헤더 줄 + |---|---| 구분선 + 본문 줄들
    if (isRow(line) && isRow(lines[i + 1]) && /^[\s|:-]+$/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 1;
      const body = [];
      while (isRow(lines[i + 1])) body.push(cells(lines[++i]));
      const thead = head.map((c) => `<th>${inline(c)}</th>`).join("");
      const tbody = body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("");
      html.push(
        `<div class="table-scroll"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      // 모달 제목이 h3 이므로 한 단계씩 낮춰 붙인다.
      const level = Math.min(heading[1].length + 1, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(---+|===+|\*\*\*+)\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!list || list.tag !== "ul") {
        flushList();
        list = { tag: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      flushPara();
      if (!list || list.tag !== "ol") {
        flushList();
        list = { tag: "ol", items: [] };
      }
      list.items.push(numbered[1]);
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  flush();
  return html.join("\n");
}

