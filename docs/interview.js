// 면담 탭 — 학생이 자기 API 키로 브라우저에서 바로 SP 면담을 한다.
// 환자 역할 AI 는 Gemini / OpenAI / Claude / OpenRouter 중에서 고른다 (PROVIDERS 참고).
// Gemini 무료 티어가 지역 차단·503 혼잡으로 불안정해서 탭을 한동안 내려뒀었는데,
// 다른 AI 로 갈아탈 수 있게 해서 다시 열었다. 시스템 프롬프트는 제공자와 무관한 평문이다.
//
// AI 호출은 cpx-worker 를 거치지 않고 브라우저가 직접 한다. Cloudflare Worker에서
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
import { scoreRecord, auditMarks, reconcileNarrative } from "./scoring.js";
import { parseEvalItems, stripEvalItems, findReason } from "./export.js";

const CONFIG_STORAGE = "cpx-ai-config"; // { provider, keys: {id: key}, models: {id: model} }
const LEGACY_GEMINI_KEY = "cpx-gemini-key"; // 예전 Gemini 전용 시절 저장 위치 — 처음 한 번 옮겨온다
const MAX_OUTPUT_TOKENS = 8192; // 평가 단계 답이 길다 (채점표 + cpx-record 블록)

// 브라우저에서 직접 부를 수 있는(CORS 허용) 제공자들. 모델 목록은 추천일 뿐이고
// 학생이 모델 칸에 아무 이름이나 적어도 된다 — 모델 이름은 자주 바뀌기 때문이다.
const PROVIDERS = {
  // 키 없이 바로 — 운영자 계정의 Cloudflare Workers AI 무료 한도로 돈다 (cpx-worker/src/aiRoutes.js).
  // 하루 전체 사용량과 1인당 면담 수가 워커에서 제한된다.
  free: {
    label: "키 없이 바로 (무료 · 하루 횟수 제한)",
    noKey: true,
    steps: [
      "API 키가 필요 없습니다. 로그인한 계정으로 바로 면담합니다.",
      "모두가 함께 쓰는 무료 한도라 하루 면담 횟수가 정해져 있습니다 (매일 오전 9시 초기화).",
      "더 많이 연습하려면 위에서 Gemini(무료 키) 등 내 키를 쓰는 방식을 고르세요.",
    ],
    models: [],
    defaultModel: "Workers AI",
  },
  gemini: {
    label: "Google Gemini (무료 키 가능)",
    keyUrl: "https://aistudio.google.com/apikey",
    steps: [
      "구글 계정으로 로그인 후 \"Create API key\" 클릭 → 키 복사",
      "무료이며 카드 등록이 필요 없습니다. 붐빌 때는 자동으로 다른 Gemini 모델로 바꿔 재시도합니다.",
    ],
    models: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"],
    defaultModel: null, // null 이면 워커(/interview/start)가 내려주는 모델을 쓴다
    // 503(혼잡)·429(한도) 때 차례로 갈아탈 모델들. 학생이 고른 모델이 맨 앞에 온다.
    fallbacks: ["gemini-flash-latest", "gemini-flash-lite-latest"],
  },
  openai: {
    label: "OpenAI (ChatGPT, 유료)",
    keyUrl: "https://platform.openai.com/api-keys",
    steps: ["\"Create new secret key\" → 키 복사 (결제 수단 등록이 필요합니다)"],
    models: ["gpt-4.1-mini", "gpt-5-mini", "gpt-6-luna", "gpt-6.1-sol"],
    defaultModel: "gpt-4.1-mini",
  },
  anthropic: {
    label: "Anthropic Claude (유료)",
    keyUrl: "https://console.anthropic.com/settings/keys",
    steps: ["\"Create Key\" → 키 복사 (크레딧 충전이 필요합니다)"],
    models: ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    defaultModel: "claude-haiku-4-5",
  },
  openrouter: {
    label: "OpenRouter (여러 AI 한 키로, 무료 모델 있음)",
    keyUrl: "https://openrouter.ai/keys",
    steps: [
      "\"Create Key\" → 키 복사",
      "모델 이름 끝이 :free 인 모델은 무료입니다 (openrouter.ai/models 에서 검색). 한국어가 자연스러운 모델을 고르세요.",
    ],
    models: ["google/gemini-2.5-flash", "openai/gpt-4.1-mini", "anthropic/claude-haiku-4.5", "deepseek/deepseek-chat-v3-0324:free"],
    defaultModel: "google/gemini-2.5-flash",
  },
};
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

  const providerSelect = $("ivProvider");
  const modelInput = $("ivModel");
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.label;
    providerSelect.appendChild(opt);
  }

  // 현재 면담 상태 — 전부 브라우저 메모리에만 있고 새로고침하면 사라진다.
  let systemPrompt = null;
  let workerModel = null; // 워커가 권하는 Gemini 기본 모델
  let safetySettings = null;
  let history = []; // 제공자 중립 형식 [{role:"user"|"assistant", text}]
  let topicLabel = "";
  let sessionId = null;
  let sending = false;
  let lastModelUsed = "";
  let freeModel = ""; // 워커가 알려준 Workers AI 모델 id (기록의 aiModel 에 남긴다)
  let aiSessionId = null; // "키 없이" 모드 — 시스템 프롬프트는 워커 KV 에 있고 이 id 로 찾는다

  // ---------------- AI 설정 (제공자·키·모델) ----------------

  function loadConfig() {
    let cfg = null;
    try {
      cfg = JSON.parse(localStorage.getItem(CONFIG_STORAGE) || "null");
    } catch {
      /* 손상됐거나 저장소를 못 쓰면 새로 시작 */
    }
    cfg = cfg && typeof cfg === "object" ? cfg : {};
    cfg.provider = PROVIDERS[cfg.provider] ? cfg.provider : "free";
    cfg.keys = cfg.keys || {};
    cfg.models = cfg.models || {};
    if (!cfg.keys.gemini) {
      try {
        const legacy = localStorage.getItem(LEGACY_GEMINI_KEY);
        if (legacy) cfg.keys.gemini = legacy;
      } catch {
        /* 무시 */
      }
    }
    return cfg;
  }
  let config = loadConfig();
  function saveConfig() {
    try {
      localStorage.setItem(CONFIG_STORAGE, JSON.stringify(config));
    } catch {
      /* 프라이빗 브라우징 등에서는 저장이 안 될 수 있다 — 이번 세션만 메모리로 대체 */
    }
  }

  const currentProvider = () => config.provider;
  const getKey = () => config.keys[config.provider] || "";
  const isFree = () => !!PROVIDERS[config.provider].noKey;
  const isReady = () => isFree() || !!getKey();
  function getModel() {
    if (isFree()) return freeModel || "Workers AI";
    const p = PROVIDERS[config.provider];
    return config.models[config.provider] || p.defaultModel || workerModel || p.models[0];
  }

  // 설정 화면을 고른 제공자에 맞게 다시 그린다 (안내 단계·추천 모델·저장된 키).
  function renderProviderForm(id) {
    const p = PROVIDERS[id];
    providerSelect.value = id;
    keyInput.classList.toggle("hidden", !!p.noKey);
    modelInput.closest("label").classList.toggle("hidden", !!p.noKey);
    $("btnSaveKey").textContent = p.noKey ? "이걸로 시작" : "저장";
    if (p.noKey) {
      $("ivProviderSteps").innerHTML = p.steps.map((t) => `<li>${esc(t)}</li>`).join("") + `<li id="ivFreeStatus">오늘 남은 양 확인 중...</li>`;
      refreshFreeStatus();
      return;
    }
    $("ivProviderSteps").innerHTML =
      `<li><a href="${p.keyUrl}" target="_blank" rel="noopener">${esc(p.keyUrl.replace(/^https:\/\//, ""))}</a> 접속</li>` +
      p.steps.map((t) => `<li>${esc(t)}</li>`).join("") +
      `<li>아래 칸에 붙여넣기</li>`;
    $("ivModelList").innerHTML = p.models.map((m) => `<option value="${esc(m)}"></option>`).join("");
    modelInput.value = config.models[id] || "";
    modelInput.placeholder = p.defaultModel || workerModel || p.models[0];
    $("ivModelHint").textContent = "비워두면 기본 모델을 씁니다.";
    keyInput.value = config.keys[id] || "";
  }
  providerSelect.addEventListener("change", () => renderProviderForm(providerSelect.value));

  function renderAiSummary() {
    $("ivAiSummary").textContent = isFree()
      ? `AI: ${PROVIDERS.free.label}`
      : `AI: ${PROVIDERS[currentProvider()].label} · 모델 ${getModel()}`;
  }

  // 오늘 무료 면담이 남았는지 — 설정 화면에서 미리 알려준다 (워커 /interview/ai/status).
  async function refreshFreeStatus() {
    const el = () => $("ivFreeStatus");
    try {
      const st = await callWorker("/interview/ai/status");
      if (!el()) return;
      if (!st.enabled) el().textContent = "지금은 이 방식을 쓸 수 없습니다 (운영자 설정 전).";
      else if (!st.canStart) el().textContent = "오늘 무료 면담이 모두 소진됐습니다. 오전 9시에 다시 열립니다.";
      else el().textContent = `오늘 무료 면담 가능 · 1인당 하루 ${st.perUserDaily}회`;
    } catch {
      if (el()) el().textContent = "남은 양을 확인하지 못했습니다.";
    }
  }

  function showKeyPanel() {
    keyPanel.classList.remove("hidden");
    startPanel.classList.add("hidden");
    chatPanel.classList.add("hidden");
  }
  function showStartPanel() {
    clearResult();
    keyPanel.classList.add("hidden");
    startPanel.classList.remove("hidden");
    chatPanel.classList.add("hidden");
    startErr.classList.add("hidden");
    renderAiSummary();
  }
  function showChatPanel() {
    keyPanel.classList.add("hidden");
    startPanel.classList.add("hidden");
    chatPanel.classList.remove("hidden");
  }

  if (isReady()) showStartPanel();
  else {
    renderProviderForm(currentProvider());
    showKeyPanel();
  }

  $("btnSaveKey").addEventListener("click", () => {
    const id = providerSelect.value;
    if (PROVIDERS[id].noKey) {
      config.provider = id;
      saveConfig();
      showStartPanel();
      return;
    }
    const k = keyInput.value.trim();
    if (!k) return;
    config.provider = id;
    config.keys[id] = k;
    const m = modelInput.value.trim();
    if (m) config.models[id] = m;
    else delete config.models[id];
    saveConfig();
    keyInput.value = "";
    showStartPanel();
  });

  $("btnChangeKey").addEventListener("click", () => {
    renderProviderForm(currentProvider());
    showKeyPanel();
  });

  // ---------------- 채팅 로그 렌더링 ----------------

  // CSS 의 scroll-behavior: smooth 는 애니메이션 도중에 말풍선·입력 중 표시가 바뀌면 끝까지 못 가고 멈춘다.
  // 새 메시지는 항상 맨 아래가 보여야 하므로 여기서는 즉시 이동한다.
  function scrollToBottom() {
    chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: "instant" });
  }

  // 케이스 주제(특히 무작위로 뽑힌 것)는 실제 시험처럼 학생이 미리 알면 안 되므로
  // 여기서는 절대 이름을 보여주지 않는다. 평가가 끝난 뒤 showEvalResult 에서만 공개한다.
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

  // 코드가 계산한 항목별 점수표 (scoring.js). AI 가 적은 숫자는 쓰지 않는다.
  // 점수 표 하나에 항목·평가·점수와 채점문의 근거를 합친다. 근거는 항목 이름 아래 작은 글씨로 붙는다.
  const MARK_CLASS = { O: "mk-o", "△": "mk-p", X: "mk-x", N: "mk-n" };
  function scoreTableHtml(scored, items = []) {
    if (!scored) return "";
    let section = "";
    const body = scored.rows
      .map((r) => {
        if (r.subtotal) return `<tr class="sub"><td>${esc(r.section)} 소계</td><td></td><td>${r.got} / ${r.pts}</td></tr>`;
        const head = r.section !== section ? `<tr class="sec"><th colspan="3">${esc(r.section)}</th></tr>` : "";
        section = r.section;
        const why = findReason(items, r.label);
        return (
          head +
          `<tr class="item"><td><div class="iv-item-name">${esc(r.label)}</div>${why ? `<div class="iv-item-why">${esc(why)}</div>` : ""}</td>` +
          `<td class="mk ${MARK_CLASS[r.mark] || ""}">${esc(r.mark === "N" ? "해당없음" : r.mark)}</td><td>${r.got} / ${r.pts}</td></tr>`
        );
      })
      .join("");
    return `<table class="iv-score"><tbody>${body}</tbody></table>`;
  }

  // 채점 결과는 대화창 안이 아니라 별도 창(#ivResultBackdrop)으로 보여 준다. 창을 닫아도 면담 화면의
  // "결과 보기" 버튼으로 다시 열 수 있다.
  const resultBackdrop = $("ivResultBackdrop");
  const resultReopen = $("btnIvResultReopen");
  function openResult() {
    resultBackdrop.classList.remove("hidden");
    $("btnIvResultExit").focus();
  }
  function closeResult() {
    resultBackdrop.classList.add("hidden");
  }
  // showStartPanel 이 초기화 때 먼저 부르므로, 이 아래에 선언된 const 를 참조하지 않고 요소를 직접 찾는다.
  function clearResult() {
    $("ivResultBackdrop").classList.add("hidden");
    $("ivResultBody").innerHTML = "";
    $("btnIvResultReopen").classList.add("hidden");
  }
  $("btnIvResultClose").addEventListener("click", closeResult);
  $("btnIvResultExit").addEventListener("click", () => {
    closeResult();
    $("btnEndInterview").click(); // 평가가 끝난 면담이라 확인창 없이 시작 화면으로 돌아간다
  });
  resultReopen.addEventListener("click", openResult);
  resultBackdrop.addEventListener("click", (e) => {
    if (e.target === resultBackdrop) closeResult();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !resultBackdrop.classList.contains("hidden")) closeResult();
  });

  function showEvalResult(record, mdText, topic, scored) {
    const total = typeof record.total === "number" ? `${record.total} / 100` : "";
    // 항목별 근거는 점수 표에 합치고, 채점문에는 잘한 점·개선점·조정 항목만 남긴다.
    // 항목 줄을 못 읽었거나 점수 표가 없으면(예전 형식) 채점문을 그대로 보여 준다.
    const items = scored ? parseEvalItems(mdText) : [];
    const narrative = items.length >= 2 ? stripEvalItems(mdText) : mdText;
    $("ivResultBody").innerHTML = `
      <div class="iv-eval-card">
        <div class="iv-eval-head">
          <span class="grade">${esc(record.grade || "채점 완료")}</span>
          <span class="score">${esc(total)}</span>
        </div>
        ${topic ? `<div class="iv-eval-topic">케이스: ${esc(topic)}</div>` : ""}
        ${scoreTableHtml(scored, items)}
        <div class="iv-eval-body md">${renderMarkdown(narrative)}</div>
      </div>`;
    $("ivResultBody").scrollTop = 0;
    resultReopen.classList.remove("hidden");
    openResult();
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

  async function callWorker(path, payload, { withAuth = false } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (withAuth) {
      const user = auth.currentUser;
      if (!user) {
        const err = new Error("login_required");
        err.data = { error: "login_required" };
        err.status = 401;
        throw err;
      }
      headers.Authorization = `Bearer ${await user.getIdToken()}`;
    }
    const res = await fetch(endpoint + path, {
      method: "POST",
      headers,
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
    const freeMsg = freeLimitMessage(err?.data);
    if (freeMsg) return freeMsg;
    return "케이스를 준비하지 못했습니다. 다시 시도해주세요.";
  }

  // "키 없이" 모드의 워커 에러 코드 → 안내 문구. 해당 없으면 null.
  function freeLimitMessage(data) {
    const code = data?.error;
    const other = " 더 연습하려면 \"AI 변경\"에서 Gemini(무료 키) 등을 고르세요.";
    if (code === "daily_budget_exhausted") return "오늘 무료 면담 한도가 모두 소진됐습니다. 오전 9시에 다시 열립니다." + other;
    if (code === "user_daily_limit") return `오늘 무료 면담을 모두 사용했습니다 (하루 ${data.limit}회). 오전 9시에 다시 열립니다.` + other;
    if (code === "rate_limited") return "요청이 너무 잦습니다. 잠시 후(10분 안에) 다시 시도해주세요.";
    if (code === "login_required" || code === "bad_token") return "로그인이 필요합니다. 다시 로그인한 뒤 시도해주세요.";
    if (code === "not_approved") return "관리자 승인 후에 쓸 수 있습니다.";
    if (code === "session_expired") return "면담 세션이 만료됐습니다. \"나가기\"를 눌러 새로 시작해주세요.";
    if (code === "ai_not_configured") return "지금은 키 없이 면담을 쓸 수 없습니다 (운영자 설정 전).";
    return null;
  }

  // ---------------- AI: 실제 면담 (브라우저가 직접 호출) ----------------

  // 제공자가 돌려준 원문 에러(JSON)에서 사람이 읽을 message 만 뽑는다.
  // Gemini·OpenAI·Anthropic·OpenRouter 모두 {error:{message}} 모양이다.
  function apiDetailText(bodyText) {
    if (!bodyText) return "";
    try {
      const parsed = JSON.parse(bodyText);
      return parsed?.error?.message || (typeof parsed?.error === "string" ? parsed.error : "");
    } catch {
      return String(bodyText).slice(0, 200);
    }
  }

  function friendlyApiError(err) {
    if (err.timeout) return "응답이 너무 늦어지고 있습니다. 방금 보낸 말을 입력창에 다시 넣어 두었으니, 잠시 후 다시 보내주세요.";
    if (isFree()) {
      let data = null;
      try {
        data = JSON.parse(err.bodyText || "null");
      } catch {
        /* 무시 */
      }
      if (data?.error === "ai_timeout") return "AI 응답이 지연됐습니다. 방금 보낸 말을 입력창에 다시 넣어 두었으니, 잠시 후 다시 보내주세요.";
      return freeLimitMessage(data) || "환자 응답을 받지 못했습니다. 잠시 후 다시 시도해주세요.";
    }
    const name = PROVIDERS[currentProvider()].label.replace(/\s*\(.*\)$/, "");
    if (err.status === undefined) return `${name}에 연결하지 못했습니다. 인터넷 연결을 확인해주세요.`;
    const detail = apiDetailText(err.bodyText);
    const suffix = detail ? `\n(${name}: ${detail})` : "";
    const s = err.status;
    if (s === 400 && /api key|api_key/i.test(detail)) return `${name} 키가 올바르지 않습니다.` + suffix;
    if (s === 401 || s === 403) return `${name} 키가 올바르지 않거나 권한이 없습니다. "나가기" → "AI 변경"에서 키를 확인하세요.` + suffix;
    if (s === 402) return `${name} 크레딧/결제가 필요합니다.` + suffix;
    if (s === 429) return "지금 요청이 몰려 있거나 한도에 걸렸습니다. 잠시 후 다시 시도하거나 다른 AI 로 바꿔보세요." + suffix;
    if (s === 404) return `모델 "${lastModelUsed}" 을(를) 찾을 수 없습니다. "AI 변경"에서 모델 이름을 확인하세요.` + suffix;
    if (s === 503 || s === 529 || s === 500) return `${name} 서버가 지금 붐빕니다. 잠시 후 다시 시도하거나 다른 AI 로 바꿔보세요.` + suffix;
    return `${name} 요청이 실패했습니다.` + suffix;
  }

  // 응답이 오지 않고 멈추는 경우(Workers AI 호출이 걸림)를 위한 상한. 평가는 재시도까지 해서 오래 걸릴 수 있다.
  const REQUEST_TIMEOUT_MS = 90000;

  async function postJson(url, headers, body) {
    let res;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const err = new Error(ctrl.signal.aborted ? "timeout" : "network_error"); // CORS·오프라인 — status 없음
      err.timeout = ctrl.signal.aborted;
      err.cause = e;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const err = new Error("api_error");
      err.status = res.status;
      err.bodyText = await res.text();
      throw err;
    }
    return res.json();
  }

  function emptyResponse(reason) {
    const err = new Error("empty_response");
    err.blockReason = reason || null;
    return err;
  }

  // 제공자별 어댑터 — 모두 (model) => 환자/채점 응답 텍스트.
  const callers = {
    async free() {
      const user = auth.currentUser;
      const data = await postJson(
        endpoint + "/interview/ai/chat",
        user ? { Authorization: `Bearer ${await user.getIdToken()}` } : {},
        { sessionId: aiSessionId, messages: history }
      );
      if (!data?.reply) throw emptyResponse();
      return data.reply;
    },
    async gemini(model) {
      const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(getKey())}`,
        {},
        {
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: history.map((h) => ({ role: h.role === "user" ? "user" : "model", parts: [{ text: h.text }] })),
          safetySettings,
          generationConfig: { temperature: 0.8, maxOutputTokens: MAX_OUTPUT_TOKENS },
        }
      );
      const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      if (!reply) throw emptyResponse(data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason);
      return reply;
    },
    async openai(model) {
      // 최신 OpenAI 추론 모델(gpt-5 계열 이후)은 temperature 를 받지 않고 max_tokens 대신
      // max_completion_tokens 를 쓴다 — 이 두 가지만 빼면 구형 모델에서도 그대로 동작한다.
      return openAiCompatible("https://api.openai.com/v1/chat/completions", {}, model, { max_completion_tokens: MAX_OUTPUT_TOKENS });
    },
    async openrouter(model) {
      return openAiCompatible(
        "https://openrouter.ai/api/v1/chat/completions",
        { "HTTP-Referer": location.origin, "X-Title": "CPX 기록판" },
        model
      );
    },
    async anthropic(model) {
      const data = await postJson(
        "https://api.anthropic.com/v1/messages",
        {
          "x-api-key": getKey(),
          "anthropic-version": "2023-06-01",
          // 학생 본인 키를 본인 브라우저에서만 쓰는 구조라 직접 호출을 허용한다.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        {
          model,
          system: systemPrompt,
          max_tokens: MAX_OUTPUT_TOKENS,
          // 매 턴 시스템 프롬프트+대화 전체를 다시 보내므로 캐시를 켜야 입력값이 1/10 로 준다
          // (안 켜면 Haiku 기준 면담 1회 비용이 약 4배).
          cache_control: { type: "ephemeral" },
          // Sonnet/Opus 5.5 는 temperature 를 받지 않고(400) 사고(thinking)를 끌 수도 없다 —
          // 대신 effort 를 낮춰 대화 턴 비용을 줄인다. Haiku 4.5 는 반대로 effort 가 에러다.
          ...(/haiku/.test(model) ? { temperature: 0.8 } : { output_config: { effort: "low" } }),
          messages: history.map((h) => ({ role: h.role, content: h.text })),
        }
      );
      const reply = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!reply) throw emptyResponse(data?.stop_reason);
      return reply;
    },
  };

  async function openAiCompatible(url, extraHeaders, model, params = { temperature: 0.8, max_tokens: MAX_OUTPUT_TOKENS }) {
    const data = await postJson(
      url,
      { Authorization: `Bearer ${getKey()}`, ...extraHeaders },
      {
        model,
        ...params,
        messages: [{ role: "system", content: systemPrompt }, ...history.map((h) => ({ role: h.role, content: h.text }))],
      }
    );
    const reply = data?.choices?.[0]?.message?.content || "";
    if (!reply) throw emptyResponse(data?.choices?.[0]?.finish_reason);
    return reply;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isBusy = (err) => [429, 500, 503, 529].includes(err.status);

  // 무료 인기 모델은 "지금 붐빕니다"(503) 가 흔하고 보통 몇 초 안에 풀린다.
  // 학생에게 바로 에러를 보여주기 전에 짧게 재시도하고, Gemini 는 대체 모델로도 갈아타 본다.
  async function callAI() {
    const provider = currentProvider();
    const primary = getModel();
    const models = [primary, ...(PROVIDERS[provider].fallbacks || []).filter((m) => m !== primary)];
    const backoffs = [1500, 3000];
    let lastErr;
    for (const [mi, model] of models.entries()) {
      lastModelUsed = model;
      for (let attempt = 0; ; attempt++) {
        try {
          return await callers[provider](model);
        } catch (err) {
          lastErr = err;
          // 무료 모드의 429 는 "오늘 한도 소진"이라 재시도해도 소용없다.
          if (!isBusy(err) || (provider === "free" && err.status === 429)) throw err;
          // 대체 모델이 남아 있으면 같은 모델은 한 번만 다시 해보고 넘어간다.
          const limit = mi < models.length - 1 ? 1 : backoffs.length;
          if (attempt >= limit) break;
          ivStatus.textContent = "환자가 답하는 중... (서버 혼잡, 재시도 중)";
          await sleep(backoffs[attempt]);
        }
      }
      if (mi < models.length - 1) ivStatus.textContent = `환자가 답하는 중... (${models[mi + 1]} 로 전환)`;
    }
    throw lastErr;
  }

  $("btnStartInterview").addEventListener("click", async () => {
    startErr.classList.add("hidden");
    const btn = $("btnStartInterview");
    btn.disabled = true;
    try {
      const payload = { topic: topicSelect.value || undefined };
      const data = isFree()
        ? await callWorker("/interview/ai/start", payload, { withAuth: true })
        : await callWorker("/interview/start", payload);
      aiSessionId = data.sessionId || null;
      if (data.sessionId) freeModel = data.model || "";
      // 무료 모드는 프롬프트를 내려받지 않는다 — 면담 진행 중 표시로만 쓰는 값을 채워둔다.
      systemPrompt = data.systemPrompt || "(server)";
      workerModel = data.model;
      safetySettings = data.safetySettings;
      // 학생이 직접 주제를 골랐어도 화면엔 안 보여준다 — 평가 후 카드에서만 공개해서
      // 무작위로 뽑았을 때와 경험이 갈리지 않게 한다.
      topicLabel = data.topic || "무작위";
      history = [];
      sessionId = crypto.randomUUID();
      ivInput.value = ""; // 이전 면담의 남은 글자가 첫 메시지에 섞이지 않게
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
    if (!text.trim() || sending) return;
    if (!systemPrompt) {
      // 평가가 끝난 면담에서 보내면 아무 반응이 없어 고장 난 것처럼 보인다.
      if (history.length) addBubble("__note", "이 면담은 끝났습니다. 위의 \"나가기\"를 눌러 새 면담을 시작해주세요.");
      return;
    }
    if (history.filter((h) => h.role === "user").length >= MAX_TURNS) {
      addBubble("__note", "이 면담은 길이 제한에 도달했습니다. \"나가기\"를 눌러 새로 시작해주세요.");
      return;
    }
    sending = true;
    $("btnIvSend").disabled = true;
    addBubble("의사", text);
    history.push({ role: "user", text: text.slice(0, 4000) });
    ivInput.value = "";
    ivStatus.textContent = "";
    showTyping();
    try {
      // 모델이 학생 신호어("평가"/"진찰")를 환자 답 끝에 스스로 붙이는 경우가 있어 지운다.
      const clean = (r) => r.replace(/(\n\s*(평가|진찰)\s*)+$/, "").trim();
      let reply = clean(await callAI());
      // 학생이 "평가"를 치지 않았는데 모델이 요약·마무리 인사를 보고 혼자 채점을 시작하는 일이
      // 있었다 (Gemma 4). 채점은 "평가" 입력에만 허용한다 — 한 번은 요청에만 안내를 덧붙여
      // 다시 받고(대화 기록엔 남기지 않음), 그래도 채점이면 채점 블록을 버린다.
      const isEvalCue = text.trim() === "평가";
      if (!isEvalCue && looksLikeEvaluation(reply)) {
        const last = history[history.length - 1];
        const original = last.text;
        last.text = `${original}\n\n(아직 "평가" 신호가 아닙니다. 채점하지 말고 환자로서 이 말에 대답하세요.)`;
        try {
          reply = clean(await callAI());
        } finally {
          last.text = original;
        }
        // 두 번째도 채점이면 본문 전체가 채점표라 환자 말로 보여줄 수 없다 — 중립 지문으로 대신한다.
        if (looksLikeEvaluation(reply)) reply = "(환자가 고개를 끄덕입니다.)";
      }
      // 연기 규칙을 설명하는 괄호 메모가 환자 말 앞에 붙는 일이 있었다 (Gemma 4:
      // "(학생의 질문은 신체 진찰에 해당하므로, 환자는 직접적인 느낌을 답합니다.)"). 채점이 아니면 지운다.
      // 진찰이 시작된 뒤에는 "(환자는 …)" 같은 소견 괄호가 정상이라 문진 중에만 적용한다.
      const examStarted = history.some(
        (h) => h.role === "user" && (/^\s*진찰\s*$/.test(h.text) || /\([^)]*(촉진|청진|타진|시진|혈압|진찰|눌러|두드려|두드리|들어보|재보|측정)[^)]*\)/.test(h.text))
      );
      if (!isEvalCue && !examStarted) reply = stripMetaNotes(reply) || reply;
      hideTyping();
      ivStatus.textContent = "";
      history.push({ role: "assistant", text: reply });

      const record = extractRecord(reply);
      let shown = record ? stripRecordBlock(reply) : reply;
      if (record) {
        // AI 가 준 O 중 대화에 근거가 없는 것은 낮춘다 (scoring.js auditMarks). 바꾼 내역은 카드와 기록에 남긴다.
        const changes = auditMarks(record, history.slice(0, -1));
        shown = reconcileNarrative(shown, record, history.slice(0, -1), changes);
        if (changes.length) {
          shown +=
            "\n\n대화 확인으로 조정한 항목\n" +
            changes.map((c) => `- ${c.label}: ${c.from} → ${c.to} (${c.reason})`).join("\n");
        }
        const scored = scoreRecord(record);
        if (scored) {
          for (const k of ["history", "pe", "ppi", "total", "grade"]) record[k] = scored[k];
        }
        showEvalResult(record, shown, record.topic || topicLabel, scored);
        addBubble("__note", "채점이 끝났습니다. 결과는 별도 창에서 볼 수 있고, 위의 \"결과 보기\"로 다시 열 수 있습니다.");
        await saveRecord(record, shown);
        addBubble("__note", "채점 결과가 \"내 기록\" 탭에 저장되었습니다.");
        systemPrompt = null; // 이 면담은 끝 — 새로 시작해야 다음 메시지가 된다
      } else {
        addBubble("환자", shown);
      }
    } catch (err) {
      hideTyping();
      ivStatus.textContent = "";
      history.pop(); // 실패한 학생 턴은 대화 맥락에서 뺀다 (다시 보내면 중복되지 않게)
      // 지연으로 실패한 말은 입력창에 돌려줘서 다시 보내기만 하면 되게 한다.
      const delayed = err.timeout || (isFree() && /"ai_timeout"/.test(err.bodyText || ""));
      if (delayed && !ivInput.value) ivInput.value = text;
      if (err.message === "empty_response") {
        addBubble("__note", "환자 역할 응답이 비어 왔습니다" + (err.blockReason ? ` (사유: ${err.blockReason})` : "") + ". 다시 시도해주세요.");
      } else {
        addBubble("__note", friendlyApiError(err));
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
    // 면담 중에는 화면이 면담 창으로 가득 차 있어서 이 버튼이 유일한 출구다. 진행 중이던 면담은 저장되지 않는다.
    const inProgress = systemPrompt && history.some((h) => h.role === "user");
    if (inProgress && !confirm("면담을 나갈까요?\n평가를 받기 전에 나가면 이 면담은 저장되지 않습니다.")) return;
    systemPrompt = null;
    showStartPanel();
  });

  // 평가처럼 생긴 답인지 — 기록 블록 없이 즉흥 평가문을 환자 말풍선에 쓰는 일도 있었다.
  // cpx-worker/src/aiLimits.js 의 looksLikeEvaluation 과 같은 기준이다.
  // 지문·소견 괄호는 두고, 학생·규칙·역할을 말하는 괄호만 지운다.
  const META_NOTE = /\([^()]*(학생|질문은|역할|규칙|시뮬레이션|프롬프트)[^()]*\)\s*/g;
  function stripMetaNotes(text) {
    return String(text || "").replace(META_NOTE, "").trim();
  }

  const EVAL_MARKERS = ["평가를 시작", "채점", "CPX", "병력청취", "병력 청취", "PPI", "잘한 점", "개선점", "총점", "Safety Netting", "신체 진찰 (", "종합 의견"];
  function looksLikeEvaluation(t) {
    if (extractRecord(t)) return true;
    return EVAL_MARKERS.filter((m) => String(t || "").includes(m)).length >= 2;
  }

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

    // 전사는 학생이 "평가"를 입력하기 전까지의 문진·진찰만이다. "평가"와 그 뒤의 채점문은 "채점 결과"에 따로 저장된다.
    const cut = history.findIndex((h) => h.role === "user" && /^\s*평가\s*$/.test(h.text));
    const script = (cut >= 0 ? history.slice(0, cut) : history)
      .map((h) => `${h.role === "user" ? "의사" : "환자"}: ${h.text}`)
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
      aiModel: `${currentProvider()}/${lastModelUsed || getModel()}`,
      createdAt: serverTimestamp(),
    };
    if (typeof record.total === "number") rec.totalScore = record.total;
    if (typeof record.history === "number") rec.historyScore = record.history;
    if (typeof record.pe === "number") rec.peScore = record.pe;
    if (typeof record.ppi === "number") rec.ppiScore = record.ppi;
    await setDoc(doc(db, "records", docId), rec);
  }
}
