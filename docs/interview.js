// 면담(Gemini) 탭 — 학생이 자기 무료 Gemini API 키로 브라우저에서 바로 SP 면담을 한다.
// 케이스 정답(dx·PE 소견)은 cpx-worker 가 들고 있고, 여기서는 절대 받지 않는다.
// 채점이 끝나면 plugin 업로드와 같은 모양의 문서를 records/recordDetails 에 직접 쓴다
// (여기는 브라우저 세션이라 Firebase Auth 로 이미 로그인돼 있으므로 워커를 거칠 필요가 없다).

import { doc, collection, setDoc, getDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { TOPICS } from "./topics.js";
import { chunkText } from "./image.js";

const KEY_STORAGE = "cpx-gemini-key";
const $ = (id) => document.getElementById(id);
const esc = (s) => {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
};

export function initInterviewTab({ db, auth, endpoint }) {
  const keyPanel = $("ivKeyPanel");
  const startPanel = $("ivStartPanel");
  const chatPanel = $("ivChatPanel");
  const keyInput = $("ivKeyInput");
  const topicSelect = $("ivTopic");
  const chatLog = $("ivChatLog");
  const chatTitle = $("ivChatTitle");
  const ivForm = $("ivForm");
  const ivInput = $("ivInput");
  const ivStatus = $("ivStatus");
  const startErr = $("ivStartErr");

  // 술기 카드(49-*)와 "나쁜 소식 전하기"(12, 별도 스키마)는 아직 웹 면담이 다루지 않는다.
  for (const t of TOPICS.filter((t) => !t.num.startsWith("49") && t.num !== "12")) {
    const opt = document.createElement("option");
    opt.value = t.name;
    opt.textContent = t.name;
    topicSelect.appendChild(opt);
  }

  let sessionId = null;
  let topicLabel = "";
  let transcript = []; // { role: "의사"|"환자", text }
  let sending = false;

  function getKey() {
    try {
      return localStorage.getItem(KEY_STORAGE) || "";
    } catch {
      return "";
    }
  }
  function setKey(k) {
    try {
      localStorage.setItem(KEY_STORAGE, k);
    } catch {
      /* 프라이빗 브라우징 등에서는 저장이 안 될 수 있다 — 이번 세션만 메모리로 대체 */
    }
  }

  function showKeyPanel() {
    keyPanel.classList.remove("hidden");
    startPanel.classList.add("hidden");
    chatPanel.classList.add("hidden");
  }
  function showStartPanel() {
    keyPanel.classList.add("hidden");
    startPanel.classList.remove("hidden");
    chatPanel.classList.add("hidden");
    startErr.classList.add("hidden");
  }
  function showChatPanel() {
    keyPanel.classList.add("hidden");
    startPanel.classList.add("hidden");
    chatPanel.classList.remove("hidden");
  }

  if (getKey()) showStartPanel();
  else showKeyPanel();

  $("btnSaveKey").addEventListener("click", () => {
    const k = keyInput.value.trim();
    if (!k) return;
    setKey(k);
    keyInput.value = "";
    showStartPanel();
  });

  $("btnChangeKey").addEventListener("click", () => {
    keyInput.value = getKey();
    showKeyPanel();
  });

  function addBubble(role, text) {
    const cls = { 의사: "iv-me", __note: "iv-note", __eval: "iv-eval" }[role] || "iv-them";
    const row = document.createElement("div");
    row.className = "iv-msg " + cls;
    row.innerHTML = `<span class="iv-bubble">${esc(text).replace(/\n/g, "<br>")}</span>`;
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function callWorker(path, payload) {
    const res = await fetch(endpoint + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + getKey() },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || "요청 실패");
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function friendlyError(err) {
    const code = err?.data?.error;
    if (code === "missing_api_key" || err.status === 401) return "키가 잘못됐거나 만료됐습니다. 키를 다시 확인해주세요.";
    if (code === "unknown_topic") return "그 주제를 찾지 못했습니다.";
    if (code === "session_expired") return "면담이 만료됐습니다. 새로 시작해주세요.";
    if (code === "too_many_turns") return "이 면담은 길이 제한에 도달했습니다. 새로 시작해주세요.";
    if (code === "gemini_error" && err?.data?.status === 429) return "지금 요청이 몰려 있습니다(무료 한도). 잠시 후 다시 시도해주세요.";
    if (code === "gemini_error" && (err?.data?.status === 400 || err?.data?.status === 403)) {
      return "Gemini 키가 올바르지 않습니다. \"키 변경\"에서 다시 확인해주세요.";
    }
    return "일시적인 오류가 발생했습니다. 다시 시도해주세요.";
  }

  $("btnStartInterview").addEventListener("click", async () => {
    startErr.classList.add("hidden");
    const btn = $("btnStartInterview");
    btn.disabled = true;
    try {
      const data = await callWorker("/interview/start", { topic: topicSelect.value || undefined });
      sessionId = data.sessionId;
      topicLabel = data.topic || "무작위";
      transcript = [];
      chatLog.innerHTML = "";
      chatTitle.textContent = `면담 중 · ${topicLabel}`;
      addBubble("환자", data.opening);
      transcript.push({ role: "환자", text: data.opening });
      ivStatus.textContent = "";
      showChatPanel();
      ivInput.focus();
    } catch (err) {
      startErr.textContent = friendlyError(err);
      startErr.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  async function sendMessage(text) {
    if (!text.trim() || sending || !sessionId) return;
    sending = true;
    addBubble("의사", text);
    transcript.push({ role: "의사", text });
    ivInput.value = "";
    ivStatus.textContent = "환자가 답하는 중...";
    try {
      const data = await callWorker("/interview/message", { sessionId, message: text });
      const record = extractRecord(data.reply);
      const shown = record ? stripRecordBlock(data.reply) : data.reply;
      addBubble(data.done ? "__eval" : "환자", shown);
      ivStatus.textContent = "";
      if (data.done && record) {
        await saveRecord(record, shown);
        addBubble("__note", "채점 결과가 내 기록에 저장되었습니다. \"내 기록\" 탭에서 확인할 수 있습니다.");
        sessionId = null;
      } else {
        transcript.push({ role: "환자", text: shown });
      }
    } catch (err) {
      ivStatus.textContent = friendlyError(err);
    } finally {
      sending = false;
    }
  }

  ivForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(ivInput.value);
  });
  $("btnCuePE").addEventListener("click", () => sendMessage("진찰"));
  $("btnCueEval").addEventListener("click", () => sendMessage("평가"));
  $("btnEndInterview").addEventListener("click", () => {
    sessionId = null;
    showStartPanel();
  });

  function extractRecord(text) {
    const m = /```cpx-record\s*([\s\S]*?)```/.exec(text || "");
    if (!m) return null;
    try {
      return JSON.parse(m[1].trim());
    } catch {
      return null;
    }
  }
  function stripRecordBlock(text) {
    return (text || "").replace(/```cpx-record[\s\S]*?```/, "").trim();
  }

  async function saveRecord(record, evalText) {
    const user = auth.currentUser;
    if (!user) return;

    let consent = false;
    try {
      const prof = await getDoc(doc(db, "users", user.uid));
      consent = prof.exists() && prof.data().consentTranscript === true;
    } catch {
      /* 못 읽으면 보수적으로 저장 안 함 */
    }

    const script = transcript.map((t) => `${t.role}: ${t.text}`).join("\n\n");
    const docId = doc(collection(db, "records")).id;

    const detail = { uid: user.uid, createdAt: serverTimestamp() };
    if (evalText) detail.evaluationChunks = chunkText(evalText);
    if (consent && script) detail.transcriptChunks = chunkText(script);
    await setDoc(doc(db, "recordDetails", docId), detail);

    const rec = {
      uid: user.uid,
      source: "web",
      topic: record.topic || topicLabel || "무작위",
      grade: record.grade || "",
      note: record.summary || "",
      hasEvaluation: !!evalText,
      hasTranscript: !!(consent && script),
      sessionId: sessionId || "",
      createdAt: serverTimestamp(),
    };
    if (typeof record.total === "number") rec.totalScore = record.total;
    if (typeof record.history === "number") rec.historyScore = record.history;
    if (typeof record.pe === "number") rec.peScore = record.pe;
    if (typeof record.ppi === "number") rec.ppiScore = record.ppi;
    await setDoc(doc(db, "records", docId), rec);
  }
}
