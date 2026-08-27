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
  addDoc,
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

const recordForm = $("recordForm");
const recordBody = $("recordBody");
const recordTable = $("recordTable");
const emptyMsg = $("emptyMsg");
const recordCount = $("recordCount");
const avgScore = $("avgScore");

const setConsent = $("setConsent");
const settingsSaved = $("settingsSaved");

let unsubscribeRecords = null;
let currentRows = [];
let profile = null; // users/{uid} 캐시

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
const views = { records: $("viewRecords"), pair: $("viewPair"), settings: $("viewSettings") };
document.querySelectorAll(".subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".subtab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    for (const [name, el] of Object.entries(views)) {
      el.classList.toggle("hidden", name !== btn.dataset.view);
    }
  });
});

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
  if (!user) {
    profile = null;
    authSection.classList.remove("hidden");
    dashboardSection.classList.add("hidden");
    navAuthed.classList.add("hidden");
    return;
  }

  authSection.classList.add("hidden");
  dashboardSection.classList.remove("hidden");
  navAuthed.classList.remove("hidden");
  whoName.textContent = user.displayName || user.email;

  $("installCmd").textContent = `claude plugin marketplace add ${MARKETPLACE}`;

  profile = await loadProfile(user);
  setConsent.checked = profile.consentTranscript === true;

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
  alert("무효화했습니다. 기기 연결 탭에서 코드를 새로 발급하세요.");
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

// ---------- 수동 기록 추가 ----------
recordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) return;

  const num = (id) => {
    const v = $(id).value;
    return v === "" ? null : parseInt(v, 10);
  };

  await addDoc(collection(db, "records"), {
    uid: user.uid,
    source: "manual",
    topic: $("fTopic").value.trim() || "무작위",
    totalScore: num("fTotal"),
    historyScore: num("fHistory"),
    peScore: num("fPe"),
    ppiScore: num("fPpi"),
    note: $("fNote").value.trim(),
    createdAt: serverTimestamp(),
  });

  recordForm.reset();
});

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
    renderRecords(currentRows);
  });
}

function fmtDate(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderRecords(rows) {
  recordCount.textContent = rows.length;

  if (rows.length === 0) {
    emptyMsg.classList.remove("hidden");
    recordTable.classList.add("hidden");
    avgScore.textContent = "";
    recordBody.innerHTML = "";
    return;
  }

  emptyMsg.classList.add("hidden");
  recordTable.classList.remove("hidden");

  const scored = rows.filter((r) => typeof r.totalScore === "number");
  avgScore.textContent = scored.length
    ? `평균 총점: ${(scored.reduce((s, r) => s + r.totalScore, 0) / scored.length).toFixed(1)}점`
    : "";

  recordBody.innerHTML = "";
  for (const r of rows) {
    const dash = (v) => (typeof v === "number" ? v : "-");
    const hasDetail = Boolean(
      r.evaluationChunks?.length || r.transcriptChunks?.length || r.evaluationText || r.transcript
    );
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(r.createdAt)}</td>
      <td>${escapeHtml(r.topic || "")}${r.source === "plugin" ? '<span class="pill">자동</span>' : ""}</td>
      <td class="score">${dash(r.totalScore)}</td>
      <td>${dash(r.historyScore)}</td>
      <td>${dash(r.peScore)}</td>
      <td>${dash(r.ppiScore)}</td>
      <td class="note">${escapeHtml(r.note || "")}</td>
      <td>${hasDetail ? '<button class="btn ghost small js-detail">보기</button>' : ""}</td>
      <td><button class="btn ghost small js-del">삭제</button></td>
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

// 긴 텍스트는 Firestore 색인 제한 때문에 1500자씩 잘려 배열로 저장된다.
// (transcript / evaluationText 단일 문자열은 구버전 기록 호환용)
function joinChunks(chunkArray, legacy) {
  if (Array.isArray(chunkArray) && chunkArray.length) return chunkArray.join("");
  return legacy || "";
}

function openDetail(r) {
  $("detailTitle").textContent = `${r.topic || "무작위"} · ${fmtDate(r.createdAt)}`;

  const evalText = joinChunks(r.evaluationChunks, r.evaluationText);
  $("paneEval").textContent = evalText || "(채점 결과 원문이 저장되지 않은 기록입니다)";

  const script = joinChunks(r.transcriptChunks, r.transcript);
  $("paneScript").textContent = script
    ? script + (r.transcriptTruncated ? "\n\n— 앞부분이 길어 잘렸습니다 —" : "")
    : "(문진 전사가 저장되지 않은 기록입니다)";

  document.querySelectorAll(".dtab")[0].click();
  backdrop.classList.remove("hidden");
}

function closeDetail() {
  backdrop.classList.add("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
