// 면담(Gemini) 탭 — 학생이 자기 무료 Gemini API 키로 브라우저에서 바로 SP 면담을 한다.
//
// Gemini 호출은 cpx-worker 를 거치지 않고 브라우저가 직접 한다. Cloudflare Worker에서
// generativelanguage.googleapis.com 으로 나가는 요청이 구글 쪽 지역 차단
// ("User location is not supported for the API use")에 걸리는 게 확인돼서, 학생
// 브라우저(실제 위치)가 직접 부르는 쪽으로 옮겼다. Worker(/interview/start)는 케이스를
// 뽑아 시스템 프롬프트만 만들어준다 — 즉 케이스 정답(dx·PE 소견)이 이제 브라우저
// 메모리에 있다. 다만 cpx-worker 저장소 자체가 공개 GitHub 레포라 케이스 JSON은
// 원래도 공개돼 있었다 — 화면 UI에 안 보이게 하는 것 이상의 은닉은 애초에 없었다.
//
// 채점이 끝나면 plugin 업로드와 같은 모양의 문서를 records/recordDetails 에 직접 쓴다
// (여기는 브라우저 세션이라 Firebase Auth 로 이미 로그인돼 있으므로 워커를 거칠 필요가 없다).

import { doc, collection, setDoc, getDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { TOPICS } from "./topics.js";
import { chunkText } from "./image.js";
import { escapeHtml as esc, renderMarkdown } from "./markdown.js";

const KEY_STORAGE = "cpx-gemini-key";
const MAX_TURNS = 80; // 학생 메시지 기준. 버그로 인한 무한루프 등으로부터의 안전장치일 뿐 — 비용은 학생 본인 몫이라 낮게 잡을 이유는 없다.
const $ = (id) => document.getElementById(id);

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

  // 현재 면담 상태 — 전부 브라우저 메모리에만 있고 새로고침하면 사라진다.
  let systemPrompt = null;
  let model = null;
  let safetySettings = null;
  let history = []; // Gemini 형식 [{role:"user"|"model", parts:[{text}]}]
  let topicLabel = "";
  let sessionId = null;
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

  // ---------------- 채팅 로그 렌더링 ----------------

  function scrollToBottom() {
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // 케이스 주제(특히 무작위로 뽑힌 것)는 실제 시험처럼 학생이 미리 알면 안 되므로
  // 여기서는 절대 이름을 보여주지 않는다. 평가가 끝난 뒤 addEvalCard 에서만 공개한다.
  function addTopicBar() {
    const bar = document.createElement("div");
    bar.className = "iv-topicbar";
    bar.innerHTML = `<span class="dot"></span> 면담이 시작되었습니다 — 먼저 말을 걸어보세요`;
    chatLog.appendChild(bar);
  }

  function addBubble(role, text) {
    const row = document.createElement("div");
    if (role === "__note") {
      row.className = "iv-msg iv-note";
      row.innerHTML = `<span class="iv-bubble">${esc(text)}</span>`;
    } else {
      const isMe = role === "의사";
      row.className = "iv-msg " + (isMe ? "iv-me" : "iv-them");
      const avatar = isMe ? "" : `<span class="iv-avatar" aria-hidden="true">🧑‍🦱</span>`;
      const bubble = `<span class="iv-bubble">${esc(text).replace(/\n/g, "<br>")}</span>`;
      row.innerHTML = isMe ? bubble : avatar + bubble;
    }
    chatLog.appendChild(row);
    scrollToBottom();
    return row;
  }

  function addEvalCard(record, mdText, topic) {
    const row = document.createElement("div");
    row.className = "iv-msg iv-eval";
    const total = typeof record.total === "number" ? `${record.total} / 100` : "";
    row.innerHTML = `
      <div class="iv-eval-card">
        <div class="iv-eval-head">
          <span class="grade">${esc(record.grade || "채점 완료")}</span>
          <span class="score">${esc(total)}</span>
        </div>
        ${topic ? `<div class="iv-eval-topic">케이스: ${esc(topic)}</div>` : ""}
        <div class="iv-eval-body md">${renderMarkdown(mdText)}</div>
      </div>`;
    chatLog.appendChild(row);
    scrollToBottom();
  }

  let typingRow = null;
  function showTyping() {
    typingRow = document.createElement("div");
    typingRow.className = "iv-msg iv-them iv-typing";
    typingRow.innerHTML =
      `<span class="iv-avatar" aria-hidden="true">🧑‍🦱</span>` +
      `<span class="iv-bubble"><span></span><span></span><span></span></span>`;
    chatLog.appendChild(typingRow);
    scrollToBottom();
  }
  function hideTyping() {
    typingRow?.remove();
    typingRow = null;
  }

  // ---------------- Worker: 케이스 뽑기 ----------------

  async function callWorker(path, payload) {
    const res = await fetch(endpoint + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  function friendlyStartError(err) {
    const code = err?.data?.error;
    if (code === "unknown_topic") return "그 주제를 찾지 못했습니다.";
    if (code === "topic_not_supported") return "이 케이스는 아직 웹 면담에서 지원하지 않습니다.";
    if (code === "case_not_bundled") return "케이스 데이터를 찾지 못했습니다 (운영자에게 알려주세요).";
    return "케이스를 준비하지 못했습니다. 다시 시도해주세요.";
  }

  // ---------------- Gemini: 실제 면담 (브라우저가 직접 호출) ----------------

  // Gemini 가 돌려준 원문 에러(JSON)에서 사람이 읽을 message 만 뽑는다.
  function geminiDetailText(bodyText) {
    if (!bodyText) return "";
    try {
      const parsed = JSON.parse(bodyText);
      return parsed?.error?.message || "";
    } catch {
      return String(bodyText).slice(0, 200);
    }
  }

  function friendlyGeminiError(status, bodyText) {
    const detail = geminiDetailText(bodyText);
    const suffix = detail ? `\n(Gemini: ${detail})` : "";
    if (status === 401 || status === 403) return "Gemini 키가 올바르지 않거나 권한이 없습니다." + suffix;
    if (status === 429) return "지금 요청이 몰려 있습니다(무료 한도). 잠시 후 다시 시도해주세요." + suffix;
    if (status === 404) return "설정된 Gemini 모델을 찾을 수 없습니다." + suffix;
    if (status === 503) return "Gemini 서버가 지금 붐빕니다. 잠시 후 다시 시도해주세요." + suffix;
    return "Gemini 요청이 실패했습니다." + suffix;
  }

  async function callGemini() {
    const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(getKey())}`;
    const res = await fetch(geminiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: history,
        safetySettings,
        generationConfig: { temperature: 0.8 },
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      const err = new Error("gemini_error");
      err.status = res.status;
      err.bodyText = bodyText;
      throw err;
    }
    const data = await res.json();
    const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!reply) {
      const blockReason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || null;
      const err = new Error("empty_response");
      err.blockReason = blockReason;
      throw err;
    }
    return reply;
  }

  $("btnStartInterview").addEventListener("click", async () => {
    startErr.classList.add("hidden");
    const btn = $("btnStartInterview");
    btn.disabled = true;
    try {
      const data = await callWorker("/interview/start", { topic: topicSelect.value || undefined });
      systemPrompt = data.systemPrompt;
      model = data.model;
      safetySettings = data.safetySettings;
      // 학생이 직접 주제를 골랐어도 화면엔 안 보여준다 — 평가 후 카드에서만 공개해서
      // 무작위로 뽑았을 때와 경험이 갈리지 않게 한다.
      topicLabel = data.topic || "무작위";
      history = [];
      sessionId = crypto.randomUUID();
      chatLog.innerHTML = "";
      chatTitle.textContent = "면담";
      addTopicBar();
      ivStatus.textContent = "";
      showChatPanel();
      ivInput.focus();
    } catch (err) {
      startErr.textContent = friendlyStartError(err);
      startErr.classList.remove("hidden");
    } finally {
      btn.disabled = false;
    }
  });

  async function sendMessage(text) {
    if (!text.trim() || sending || !systemPrompt) return;
    if (history.filter((h) => h.role === "user").length >= MAX_TURNS) {
      addBubble("__note", "이 면담은 길이 제한에 도달했습니다. 새로 시작해주세요.");
      return;
    }
    sending = true;
    $("btnIvSend").disabled = true;
    addBubble("의사", text);
    history.push({ role: "user", parts: [{ text: text.slice(0, 4000) }] });
    ivInput.value = "";
    ivStatus.textContent = "";
    showTyping();
    try {
      const reply = await callGemini();
      hideTyping();
      history.push({ role: "model", parts: [{ text: reply }] });

      const record = extractRecord(reply);
      const shown = record ? stripRecordBlock(reply) : reply;
      if (record) {
        addEvalCard(record, shown, record.topic || topicLabel);
        await saveRecord(record, shown);
        addBubble("__note", "채점 결과가 \"내 기록\" 탭에 저장되었습니다.");
        systemPrompt = null; // 이 면담은 끝 — 새로 시작해야 다음 메시지가 된다
      } else {
        addBubble("환자", shown);
      }
    } catch (err) {
      hideTyping();
      history.pop(); // 실패한 학생 턴은 대화 맥락에서 뺀다 (다시 보내면 중복되지 않게)
      if (err.message === "empty_response") {
        addBubble("__note", "환자 역할 응답이 비어 왔습니다" + (err.blockReason ? ` (사유: ${err.blockReason})` : "") + ". 다시 시도해주세요.");
      } else {
        addBubble("__note", friendlyGeminiError(err.status, err.bodyText));
      }
    } finally {
      sending = false;
      $("btnIvSend").disabled = false;
    }
  }

  ivForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(ivInput.value);
  });
  $("btnCuePE").addEventListener("click", () => sendMessage("진찰"));
  $("btnCueEval").addEventListener("click", () => sendMessage("평가"));
  $("btnEndInterview").addEventListener("click", () => {
    systemPrompt = null;
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

  // ---------------- 기록 저장 ----------------

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

    const script = history
      .map((h) => `${h.role === "user" ? "의사" : "환자"}: ${(h.parts || []).map((p) => p.text || "").join("")}`)
      .join("\n\n");
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
