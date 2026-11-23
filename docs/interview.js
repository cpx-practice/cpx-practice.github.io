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
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { TOPICS } from "./topics.js";
import { chunkText } from "./image.js";
import { escapeHtml as esc, renderMarkdown } from "./markdown.js";
import { scoreRecord, auditMarks, reconcileNarrative, reconcileTotal } from "./scoring.js";
import { parseEvalItems, stripEvalItems, findReason, applyMarkChanges } from "./export.js";
import { claimConfig, mergeCloud, cloudPayload } from "./aikeys.js";
import { initVoice } from "./voice.js";

const CONFIG_STORAGE = "cpx-ai-config"; // { provider, keys: {id: key}, models: {id: model}, ownerUid, cloud }
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

// 전사용 — 환자 답 가운데 괄호로만 된 줄은 진찰 소견(서술자)이라 "진찰:"로, 나머지는 "환자:"로 붙인다.
export function transcriptReply(text) {
  const out = [];
  let said = [];
  const flush = () => {
    while (said.length && !said[said.length - 1].trim()) said.pop();
    if (said.length) out.push(`환자: ${said.join("\n")}`);
    said = [];
  };
  for (const line of String(text || "").split("\n")) {
    const m = line.trim().match(/^[(（]([^()（）]*)[)）]$/);
    if (m) {
      flush();
      out.push(`진찰: ${m[1].trim()}`);
    } else if (line.trim() || said.length) said.push(line);
  }
  flush();
  return out.join("\n") || "환자: ";
}

export function initInterviewTab({ db, auth, endpoint, onStudy }) {
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
  // 말로 묻기(마이크)와 환자 답 읽어 주기 — 브라우저 내장 음성 기능만 쓴다 (voice.js).
  const voice = initVoice({
    input: $("ivInput"),
    micButton: $("btnIvMic"),
    ttsToggle: $("ivTts"),
    ttsWrap: $("ivTtsWrap"),
    onStatus: (msg) => {
      ivStatus.textContent = msg;
    },
  });
  const startErr = $("ivStartErr");
  const startAlt = $("ivStartAlt"); // 무료 한도가 소진됐을 때 "내 키로 계속하기" 버튼을 담는 자리

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
  let evalDone = false; // 평가가 끝났는지 — 오류 제보에 주제를 넣어도 되는 때(평가 전에는 무작위 케이스를 가려야 한다)
  let sending = false;
  let walkedOut = false; // 환자가 퇴실한 면담 — 서버(misconduct.js)의 고정 응답을 알아보고 입력을 막는다

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
    renderCloudControls(!!p.noKey);
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
      : `AI: ${PROVIDERS[currentProvider()].label} · 모델 ${getModel()}${config.cloud ? " · 계정에 키 저장됨" : ""}`;
  }

  // 오늘 무료 면담이 남았는지 — 설정 화면에서 미리 알려준다 (워커 /interview/ai/status).
  async function refreshFreeStatus() {
    const el = () => $("ivFreeStatus");
    try {
      const st = await callWorker("/interview/ai/status");
      if (!el()) return;
      if (!st.enabled) el().textContent = "지금은 이 방식을 쓸 수 없습니다. 다른 AI를 고르거나 잠시 후 다시 확인해 주세요.";
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
  // ---------------- 면담 타이머 ----------------
  // 실제 시험처럼 남은 시간을 보여 준다. 시간이 다 돼도 면담을 끊지는 않고 안내만 한다.
  const TIMER_KEY = "cpx-iv-timer";
  const timerSelect = $("ivTimer");
  const timerShow = $("ivTimerShow");
  let timerId = null;
  try {
    const saved = localStorage.getItem(TIMER_KEY);
    if (saved && timerSelect && [...timerSelect.options].some((o) => o.value === saved)) timerSelect.value = saved;
  } catch {}
  timerSelect?.addEventListener("change", () => {
    try {
      localStorage.setItem(TIMER_KEY, timerSelect.value);
    } catch {}
  });
  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
    timerShow?.classList.add("hidden");
    timerShow?.classList.remove("warn", "over");
  }
  function startTimer() {
    stopTimer();
    const min = Number(timerSelect?.value || 0);
    if (!min || !timerShow) return;
    const end = Date.now() + min * 60 * 1000;
    let noted = false;
    const tick = () => {
      const left = Math.round((end - Date.now()) / 1000);
      const a = Math.abs(left);
      const mmss = `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}`;
      timerShow.textContent = left >= 0 ? `남은 시간 ${mmss}` : `시간 초과 +${mmss}`;
      timerShow.classList.toggle("warn", left <= 60 && left >= 0);
      timerShow.classList.toggle("over", left < 0);
      if (left < 0 && !noted) {
        noted = true;
        addBubble("__note", "정해 둔 시간이 지났습니다. 마무리하고 평가를 받아 보세요.");
      }
    };
    timerShow.classList.remove("hidden");
    tick();
    timerId = setInterval(tick, 1000);
  }

  function showStartPanel() {
    stopTimer();
    clearResult();
    keyPanel.classList.add("hidden");
    startPanel.classList.remove("hidden");
    chatPanel.classList.add("hidden");
    startErr.classList.add("hidden");
    startAlt.classList.add("hidden");
    renderAiSummary();
  }
  function showChatPanel() {
    keyPanel.classList.add("hidden");
    startPanel.classList.add("hidden");
    chatPanel.classList.remove("hidden");
    startTimer();
  }

  if (isReady()) showStartPanel();
  else {
    renderProviderForm(currentProvider());
    showKeyPanel();
  }

  // ---------------- 계정에 키 저장 (선택) ----------------
  // 기본은 이 브라우저에만 둔다. 사용자가 체크박스를 켠 경우에만 워커(/interview/ai/keys, KV)에 올린다 — 본인 토큰으로만 본인 것을 읽고 쓴다. Firebase 규칙은 필요 없다.

  let autoKeyPanel = false; // 키가 없어서 처음부터 설정 화면이 떠 있는 경우 — 계정에서 키를 받아오면 시작 화면으로 넘어간다

  function renderCloudControls(noKey) {
    $("ivCloudBox").classList.toggle("hidden", noKey);
    $("ivCloudSave").checked = config.cloud === true;
    $("btnDeleteCloudKeys").classList.toggle("hidden", !(config.cloud || Object.keys(config.keys).length));
  }
  async function pushCloud() {
    await callWorker("/interview/ai/keys", { action: "put", ...cloudPayload(config) }, { withAuth: true });
  }
  async function deleteCloud() {
    await callWorker("/interview/ai/keys", { action: "delete" }, { withAuth: true });
  }

  // 로그인하면: 이 브라우저의 설정이 내 것인지 확인하고(다른 계정 것이면 비운다), 계정에 저장해 둔 키를 합친다.
  async function syncAccountKeys(user) {
    const before = JSON.stringify(config);
    config = claimConfig(config, user.uid);
    try {
      const data = await callWorker("/interview/ai/keys", { action: "get" }, { withAuth: true });
      if (data && data.aiKeys && Object.keys(data.aiKeys).length) config = mergeCloud(config, data);
      else config.cloud = false;
    } catch {
      /* 서버에 닿지 않거나 오프라인 — 이 기기의 설정만 쓴다 */
    }
    saveConfig();
    if (JSON.stringify(config) === before) return;
    if (!keyPanel.classList.contains("hidden")) {
      if (autoKeyPanel && isReady()) showStartPanel();
      else renderProviderForm(currentProvider());
    } else {
      renderAiSummary();
    }
    autoKeyPanel = false;
  }

  $("btnSaveKey").addEventListener("click", async () => {
    const id = providerSelect.value;
    const noKey = !!PROVIDERS[id].noKey;
    if (noKey) {
      config.provider = id;
    } else {
      const k = keyInput.value.trim();
      if (!k) return;
      config.provider = id;
      config.keys[id] = k;
      const m = modelInput.value.trim();
      if (m) config.models[id] = m;
      else delete config.models[id];
    }
    const wantCloud = noKey ? config.cloud === true : $("ivCloudSave").checked;
    const hadCloud = config.cloud === true;
    const msg = $("ivKeySavedMsg");
    msg.textContent = "";
    try {
      if (wantCloud) {
        config.cloud = true;
        await pushCloud();
      } else if (hadCloud) {
        await deleteCloud(); // 체크를 껐으면 계정에 올려 둔 사본도 지운다
        config.cloud = false;
      }
    } catch {
      // 이 기기에는 저장하되, 계정 저장은 실패했음을 알린다 (서버 연결 문제 등).
      config.cloud = hadCloud;
      saveConfig();
      renderCloudControls(noKey); // 이 기기에는 키가 저장됐으니 삭제 버튼도 보여 준다
      msg.textContent = "이 기기에는 저장했지만 계정에는 저장하지 못했습니다 (서버 연결 문제일 수 있습니다). 다시 시도하려면 저장을 누르세요.";
      return;
    }
    saveConfig();
    keyInput.value = "";
    showStartPanel();
  });

  $("btnDeleteCloudKeys").addEventListener("click", async () => {
    if (!confirm("저장된 키를 이 기기와 내 계정에서 모두 지울까요?\n다시 쓰려면 키를 새로 붙여넣어야 합니다.")) return;
    const msg = $("ivKeySavedMsg");
    let cloudDeleted = true;
    try {
      await deleteCloud();
    } catch {
      cloudDeleted = false;
    }
    config.keys = {};
    config.models = {};
    config.provider = "free";
    config.cloud = false;
    saveConfig();
    keyInput.value = "";
    renderProviderForm("free");
    msg.textContent = cloudDeleted ? "이 기기와 계정에서 지웠습니다." : "이 기기에서는 지웠지만 계정의 사본을 지우지 못했습니다. 잠시 후 다시 시도해 주세요.";
  });

  $("btnChangeKey").addEventListener("click", () => {
    renderProviderForm(currentProvider());
    showKeyPanel();
  });

  // 필요한 함수·변수가 모두 선언된 뒤에 등록한다.
  autoKeyPanel = !keyPanel.classList.contains("hidden");
  onAuthStateChanged(auth, (user) => {
    if (user) syncAccountKeys(user);
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

  // 환자 답을 앞에서부터 한 글자씩 보여 준다 (말하는 느낌). 응답은 이미 다 받아 둔 상태라 서버와는 무관하다.
  // 길어도 2초 안에 끝나게 속도를 맞추고, 말풍선을 누르거나 다음 말을 보내면 바로 다 보여 준다.
  // 움직임 줄이기를 켠 기기에서는 하지 않는다.
  let finishTyping = null;
  const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  function typeOut(el, text) {
    finishTyping?.();
    const chars = [...text];
    if (REDUCED_MOTION || chars.length < 2) {
      el.textContent = text;
      return;
    }
    const perChar = Math.max(8, Math.min(35, Math.floor(2000 / chars.length)));
    let i = 0;
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      el.textContent = text;
      el.classList.remove("typing-out");
      el.removeEventListener("click", done);
      if (finishTyping === done) finishTyping = null;
      scrollToBottom();
    };
    finishTyping = done;
    el.classList.add("typing-out");
    el.addEventListener("click", done);
    el.textContent = "";
    const step = () => {
      i = Math.min(chars.length, i + 1);
      el.textContent = chars.slice(0, i).join("");
      if (i % 8 === 0) scrollToBottom();
      if (i >= chars.length) return done();
      timer = setTimeout(step, perChar);
    };
    step();
  }

  function addBubble(role, text) {
    finishTyping?.(); // 앞 말풍선이 아직 나오는 중이면 마저 다 보여 준다
    const row = document.createElement("div");
    if (role === "__walkout") {
      row.className = "iv-msg iv-note iv-walkout";
      row.innerHTML = `<span class="iv-bubble">🚪 ${esc(text)}</span>`;
    } else if (role === "__note") {
      row.className = "iv-msg iv-note";
      row.innerHTML = `<span class="iv-bubble">${esc(text)}</span>`;
    } else {
      const isMe = role === "의사";
      row.className = "iv-msg " + (isMe ? "iv-me" : "iv-them");
      const avatar = isMe ? "" : `<span class="iv-avatar" aria-hidden="true">🧑‍🦱</span>`;
      const bubble = `<span class="iv-bubble">${esc(text).replace(/\n/g, "<br>")}</span>`;
      row.innerHTML = isMe ? bubble : avatar + bubble;
      if (role === "환자") {
        const el = row.querySelector(".iv-bubble");
        el.classList.add("iv-said"); // 줄바꿈을 글자로 보여 주므로 pre-wrap (style.css)
        chatLog.appendChild(row);
        typeOut(el, String(text));
        scrollToBottom();
        return row;
      }
    }
    chatLog.appendChild(row);
    scrollToBottom();
    return row;
  }

  // 서버가 무례·부정행위로 환자를 퇴실시키면 고정 응답이 온다. 말풍선 대신 안내 카드로 보이고, "평가"만 받는다.
  const WALKOUT_REPLY = /^\(환자(가 화를 내며[\s\S]*진료실을 나가 버렸|는 이미 진료실을 나갔)[\s\S]{0,120}\)$/;
  function setWalkedOut(on) {
    walkedOut = on;
    ivInput.disabled = on;
    ivInput.placeholder = on ? '환자가 나갔습니다 — "평가"를 눌러주세요' : "메시지를 입력하세요";
    $("btnIvSend").disabled = on || sending;
    $("btnCuePE").disabled = on;
    $("btnCueEval").classList.toggle("primary", on);
    $("btnCueEval").classList.toggle("ghost", !on);
    if (on) $("btnCueEval").focus();
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
    evalDone = false;
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
  // 위에 겹쳐 뜬 창부터 Esc 로 닫는다: 오류 제보 창 → 채점 결과 창.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("ivReportBackdrop").classList.contains("hidden")) closeReport();
    else if (!resultBackdrop.classList.contains("hidden")) closeResult();
  });

  // ---------------- 면담 중·직후 오류 제보 ----------------
  // 면담은 전체 화면이라 오류 제보 탭이 가려진다. 여기서 바로 보낸다 — 저장 형식은 오류 제보 탭과 같다(관리자 화면에 같이 모인다).
  const reportBackdrop = $("ivReportBackdrop");
  function openReport() {
    $("ivReportErr").textContent = "";
    $("ivReportDone").classList.add("hidden");
    reportBackdrop.classList.remove("hidden");
    $("ivReportText").focus();
  }
  function closeReport() {
    reportBackdrop.classList.add("hidden");
  }
  $("btnIvReport").addEventListener("click", openReport);
  $("btnIvResultReport").addEventListener("click", openReport);
  $("btnIvReportClose").addEventListener("click", closeReport);
  reportBackdrop.addEventListener("click", (e) => {
    if (e.target === reportBackdrop) closeReport();
  });
  $("ivReportText").addEventListener("input", () => {
    $("ivReportCount").textContent = `${$("ivReportText").value.length} / 1800`;
  });
  $("btnIvReportSend").addEventListener("click", async () => {
    const user = auth.currentUser;
    const raw = $("ivReportText").value.trim();
    const err = $("ivReportErr");
    err.textContent = "";
    if (!user) return;
    if (!raw) {
      err.textContent = "내용을 적어주세요.";
      return;
    }
    const btn = $("btnIvReportSend");
    btn.disabled = true;
    try {
      let nickname = "";
      try {
        const prof = await getDoc(doc(db, "users", user.uid));
        nickname = prof.exists() ? prof.data().nickname || "" : "";
      } catch {
        /* 프로필을 못 읽어도 제보는 보낸다 */
      }
      // 재현에 필요한 면담 정보를 붙인다. 주제는 평가가 끝난 뒤에만 — 평가 전에 보내도 무작위 케이스가 드러나지 않게.
      const info = [`세션 ${aiSessionId || sessionId || "-"}`, evalDone ? `주제 ${topicLabel}` : "진행 중", `AI ${currentProvider()}`].join(" · ");
      await setDoc(doc(collection(db, "reports")), {
        uid: user.uid,
        nickname: nickname || user.displayName || "",
        email: user.email || "",
        text: `${raw}\n\n[면담 정보] ${info}`.slice(0, 2000),
        page: evalDone ? "면담 · 평가 후" : "면담 · 진행 중",
        agent: navigator.userAgent.slice(0, 300),
        status: "open",
        hasImage: false,
        createdAt: serverTimestamp(),
      });
      $("ivReportText").value = "";
      $("ivReportCount").textContent = "0 / 1800";
      $("ivReportDone").classList.remove("hidden");
      setTimeout(closeReport, 1600);
    } catch (e) {
      err.textContent = `보내지 못했습니다: ${e.code || e.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // 복습 — 점수가 깎인 병력청취 항목을 공부 탭의 같은 주제 가이드로 잇는다.
  // 채점표는 모든 주제가 같은 큰 항목이라 "몇 번째 단계를 놓쳤다"까지는 못 짚고, 그 항목을 익히는 가이드 부분으로 보낸다.
  const REVIEW_LINKS = {
    "주호소&현병력": ["hpi", "현병력 질문"],
    "Red Flag/감별진단": ["redflag", "위험 신호·배제 질문"],
    "과거력·약물력·가족력·사회력": ["pmh", "과거력·약 질문"],
    "Safety Netting": ["pitfalls", "놓치기 쉬운 것"],
  };
  function reviewHtml(scored, topic) {
    if (!onStudy || !topic || topic === "무작위") return "";
    const missed = (scored?.rows || []).filter((r) => !r.subtotal && (r.mark === "X" || r.mark === "△") && REVIEW_LINKS[r.label]);
    const list = missed
      .map((r) => {
        const [sec, name] = REVIEW_LINKS[r.label];
        return `<li><span class="mk ${MARK_CLASS[r.mark]}">${esc(r.mark)}</span> ${esc(r.label)} → <button type="button" class="linklike" data-study="${sec}">${esc(name)} 보기</button></li>`;
      })
      .join("");
    return (
      `<div class="iv-review"><div class="iv-review-head">복습하기</div>` +
      (list
        ? `<p class="hint">점수가 깎인 항목을 공부 탭의 「${esc(topic)}」 가이드에서 다시 볼 수 있습니다.</p><ul>${list}</ul>`
        : `<p class="hint">병력청취 항목은 잘 챙겼습니다. 「${esc(topic)}」 가이드로 다른 진단도 훑어보세요.</p>`) +
      `<button type="button" class="btn small" data-study="">이 주제 공부하기</button></div>`
    );
  }
  // 결과 창의 "같은 주제로 다시" · "무작위로 새 면담" — 이 면담을 끝내고 그 주제로 곧바로 새 면담을 시작한다.
  // 같은 주제여도 시나리오는 다시 무작위로 뽑힌다.
  $("ivResultBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-again]");
    if (!b) return;
    $("btnIvResultExit").click(); // 평가가 끝난 면담이라 확인창 없이 시작 화면으로 돌아간다
    topicSelect.value = b.dataset.again;
    topicSelect.dispatchEvent(new Event("change", { bubbles: true }));
    $("btnStartInterview").click();
  });
  $("ivResultBody").addEventListener("click", (e) => {
    const b = e.target.closest("[data-study]");
    if (!b || !onStudy) return;
    const topic = $("ivResultBody").dataset.topic;
    $("btnIvResultExit").click(); // 결과 창을 닫고 면담을 끝낸 뒤(평가가 끝나 확인창 없음) 공부 탭으로 간다
    onStudy(topic, b.dataset.study || "");
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
        <div class="iv-next">
          ${topic && topic !== "무작위" && [...topicSelect.options].some((o) => o.value === topic)
            ? `<button type="button" class="btn small primary" data-again="${esc(topic)}">같은 주제로 다시</button>`
            : ""}
          <button type="button" class="btn small" data-again="">무작위로 새 면담</button>
        </div>
        ${scoreTableHtml(scored, items)}
        ${reviewHtml(scored, topic)}
        <div class="iv-eval-body md">${renderMarkdown(narrative)}</div>
      </div>`;
    $("ivResultBody").dataset.topic = topic || "";
    $("ivResultBody").scrollTop = 0;
    evalDone = true;
    stopTimer();
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
    if (code === "case_not_bundled") return "케이스를 불러오지 못했습니다. 다른 주제로 시작하거나 \"오류 제보\" 탭으로 알려 주세요.";
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
    if (code === "ai_busy") return "AI 서버가 잠시 혼잡합니다. 방금 보낸 말을 입력창에 다시 넣어 두었으니, 잠시 후 다시 보내주세요.";
    if (code === "ai_not_configured") return "지금은 키 없이 면담을 쓸 수 없습니다. \"AI 변경\"에서 Gemini(무료 키) 등을 골라 주세요.";
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
      // 원인을 나중에 추적할 수 있게 상태·오류 코드를 작게 덧붙인다 (사용자가 제보할 때 그대로 알려줄 수 있다).
      const code = [err.status, data?.error].filter(Boolean).join(" ");
      return freeLimitMessage(data) || `환자 응답을 받지 못했습니다. 잠시 후 다시 시도해주세요.${code ? ` (${code})` : " (연결 실패)"}`;
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
        { "HTTP-Referer": location.origin, "X-Title": "CPXpert" },
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
  // 서버가 돌려준 무료 모드 에러 코드 (본문이 JSON 이 아니면 null).
  function freeErrorCode(err) {
    try {
      return JSON.parse(err.bodyText || "null")?.error || null;
    } catch {
      return null;
    }
  }

  // 대화창 안에서 본인 Gemini 키를 받는다 — 키를 붙여넣고 "이어서 하기"를 누르면 키를, "그만두기"면 null 을 돌려준다.
  function askOwnKey() {
    return new Promise((resolve) => {
      const row = document.createElement("div");
      row.className = "iv-msg iv-note";
      row.innerHTML =
        `<span class="iv-bubble">` +
        `<a href="${PROVIDERS.gemini.keyUrl}" target="_blank" rel="noopener">Google AI Studio</a> 에서 무료 키를 만들어 붙여넣으세요.<br>` +
        `<input type="password" class="iv-ownkey" autocomplete="off" placeholder="Gemini API 키" style="width:70%;margin:6px 0"> ` +
        `<button class="btn primary small js-ok">이어서 하기</button> <button class="btn ghost small js-no">그만두기</button>` +
        `</span>`;
      chatLog.appendChild(row);
      scrollToBottom();
      const input = row.querySelector("input");
      input.focus();
      const done = (v) => {
        row.remove();
        resolve(v);
      };
      row.querySelector(".js-ok").addEventListener("click", () => {
        const v = input.value.trim();
        if (v) done(v);
        else input.focus();
      });
      row.querySelector(".js-no").addEventListener("click", () => done(null));
    });
  }

  // 두 AI(Workers AI·운영자 Gemini)가 모두 소진돼 면담이 끊기게 됐을 때 — 본인 Gemini 키로 같은 면담을 이어간다.
  // 소진이 확인된 경우에만 서버가 전체 프롬프트를 내려준다 (/interview/ai/handoff). 성공하면 true.
  async function handoffToOwnKey() {
    hideTyping();
    addBubble("__note", "오늘 무료 AI 한도가 모두 소진됐습니다. 내 Gemini 키가 있으면 이 면담을 이어서 진행할 수 있습니다.");
    if (!config.keys.gemini) {
      const key = await askOwnKey();
      if (!key) return false;
      config.keys.gemini = key;
      saveConfig();
    }
    let data;
    try {
      data = await callWorker("/interview/ai/handoff", { sessionId: aiSessionId }, { withAuth: true });
    } catch {
      addBubble("__note", "면담을 이어가지 못했습니다. \"나가기\"를 눌러 새로 시작해주세요.");
      return false;
    }
    systemPrompt = data.systemPrompt;
    safetySettings = data.safetySettings || safetySettings;
    workerModel = null; // 무료 모드에서 받아 둔 Workers AI 모델 id 가 Gemini 모델명으로 새어 들어가지 않게 (getModel 참고)
    config.provider = "gemini";
    saveConfig();
    renderAiSummary();
    addBubble("__note", "내 Gemini 키로 이어서 진행합니다.");
    showTyping();
    return true;
  }

  async function callAI() {
    try {
      return await callAIOnce();
    } catch (err) {
      if (!(currentProvider() === "free" && aiSessionId && err.status === 429 && freeErrorCode(err) === "daily_budget_exhausted")) throw err;
      if (!(await handoffToOwnKey())) throw err;
      return callAIOnce(); // 이제 제공자는 gemini
    }
  }

  async function callAIOnce() {
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

  // 무료 한도(전체 소진·1인당 횟수)에 걸렸을 때 — 내 Gemini 키로 바로 이어가거나, 키를 연결하는 화면으로 안내한다.
  function offerOwnKey() {
    startAlt.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "btn primary small";
    if (config.keys.gemini) {
      btn.textContent = "내 Gemini 키로 계속하기";
      btn.addEventListener("click", () => {
        config.provider = "gemini";
        saveConfig();
        renderAiSummary();
        startAlt.classList.add("hidden");
        $("btnStartInterview").click();
      });
    } else {
      btn.textContent = "내 Gemini 키 연결하기";
      btn.addEventListener("click", () => {
        renderProviderForm("gemini");
        showKeyPanel();
      });
    }
    startAlt.appendChild(btn);
    startAlt.classList.remove("hidden");
  }

  $("btnStartInterview").addEventListener("click", async () => {
    startErr.classList.add("hidden");
    startAlt.classList.add("hidden");
    const btn = $("btnStartInterview");
    btn.disabled = true;
    try {
      const payload = { topic: topicSelect.value || undefined };
      // 관리자 점검용 시나리오 지정 (서버가 관리자일 때만 받는다)
      if (adminOn && topicSelect.value && scenarioSelect && scenarioSelect.value) payload.scenarioId = scenarioSelect.value;
      // 지정은 이번 면담 한 번만 쓴다 — 다음 면담은 다시 무작위로 시작한다.
      if (scenarioSelect) scenarioSelect.value = "";
      // 관리자 점검용 — 카드 내용 점검처럼 모델과 무관한 확인은 Gemini 로 돌려 학생 몫의 Workers AI 한도를 아낀다.
      // 연기 규칙(프롬프트) 확인은 학생이 쓰는 기본 경로로 해야 하므로 기본값은 그대로 둔다. 이 선택은 바꿀 때까지 유지된다.
      if (adminOn && backendSelect && backendSelect.value === "gemini") payload.forceGemini = true;
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
      voice.setSpeaker(data.speaker); // 읽어 주기 목소리를 환자(또는 대신 답하는 보호자)의 성별·나이에 맞춘다
      history = [];
      sessionId = crypto.randomUUID();
      ivInput.value = ""; // 이전 면담의 남은 글자가 첫 메시지에 섞이지 않게
      setWalkedOut(false);
      chatLog.innerHTML = "";
      // 관리자에게만 이번 면담이 어느 모델로 도는지 보여 준다 (점검 결과를 어느 경로의 것으로 읽을지 헷갈리지 않게).
      // 모델 원래 이름(@cf/google/gemma-4-26b-a4b-it 등)은 길어서 짧은 이름으로 작게 붙인다.
      const shortModel = (m) => {
        const t = String(m || "");
        if (/gemma-?4/i.test(t)) return "Gemma 4";
        if (/gemma/i.test(t)) return "Gemma";
        if (/gemini/i.test(t)) return t.replace(/^models\//, "").replace(/^gemini-/i, "Gemini ").replace(/-/g, " ");
        return t.split("/").pop();
      };
      chatTitle.innerHTML =
        "면담 중" + (adminOn && data.sessionId && data.model ? ` <span class="iv-model">${esc(shortModel(data.model))}</span>` : "");
      addTopicBar();
      ivStatus.textContent = "";
      showChatPanel();
      ivInput.focus();
    } catch (err) {
      startErr.textContent = friendlyStartError(err);
      startErr.classList.remove("hidden");
      if (isFree() && ["daily_budget_exhausted", "user_daily_limit"].includes(err?.data?.error)) offerOwnKey();
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
    if (walkedOut && text.trim() !== "평가") {
      addBubble("__note", '환자가 진료실을 나갔습니다. "평가"를 눌러 결과를 확인해주세요.');
      return;
    }
    sending = true;
    $("btnIvSend").disabled = true;
    voice.stop(); // 읽던 환자 답·듣던 마이크를 멈춘다
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
          shown = applyMarkChanges(shown, changes); // 표의 평가도 조정 후 값으로 (아래 목록은 이유 설명으로 남긴다)
          shown +=
            "\n\n대화 확인으로 조정한 항목\n" +
            changes.map((c) => `- ${c.label}: ${c.from} → ${c.to} (${c.reason})`).join("\n");
        }
        const scored = scoreRecord(record);
        if (scored) {
          for (const k of ["history", "pe", "ppi", "total", "grade"]) record[k] = scored[k];
          shown = reconcileTotal(shown, scored); // 서술문의 총점도 계산값으로 (AI 가 쓴 숫자가 표와 엇갈리지 않게)
        }
        showEvalResult(record, shown, record.topic || topicLabel, scored);
        addBubble("__note", "채점이 끝났습니다. 결과는 별도 창에서 볼 수 있고, 위의 \"결과 보기\"로 다시 열 수 있습니다.");
        await saveRecord(record, shown);
        addBubble("__note", "채점 결과가 \"기록\" 탭에 저장되었습니다.");
        systemPrompt = null; // 이 면담은 끝 — 새로 시작해야 다음 메시지가 된다
      } else if (WALKOUT_REPLY.test(shown.trim())) {
        addBubble("__walkout", shown.trim().replace(/^\(|\)$/g, ""));
        setWalkedOut(true);
      } else {
        addBubble("환자", shown);
        voice.speak(shown);
      }
    } catch (err) {
      hideTyping();
      ivStatus.textContent = "";
      console.warn("면담 응답 실패", { status: err.status, timeout: !!err.timeout, body: String(err.bodyText || "").slice(0, 300) });
      history.pop(); // 실패한 학생 턴은 대화 맥락에서 뺀다 (다시 보내면 중복되지 않게)
      // 지연으로 실패한 말은 입력창에 돌려줘서 다시 보내기만 하면 되게 한다.
      const delayed = err.timeout || (isFree() && /"ai_timeout"|"ai_busy"/.test(err.bodyText || ""));
      if (delayed && !ivInput.value) ivInput.value = text;
      if (err.message === "empty_response") {
        addBubble("__note", "환자 역할 응답이 비어 왔습니다" + (err.blockReason ? ` (사유: ${err.blockReason})` : "") + ". 다시 시도해주세요.");
      } else {
        addBubble("__note", friendlyApiError(err));
      }
    } finally {
      sending = false;
      $("btnIvSend").disabled = walkedOut;
    }
  }

  ivForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage(ivInput.value);
  });
  $("btnCuePE").addEventListener("click", () => sendMessage("진찰"));
  $("btnCueEval").addEventListener("click", () => sendMessage("평가"));
  $("btnEndInterview").addEventListener("click", () => {
    voice.stop();
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
      .map((h) => (h.role === "user" ? `의사: ${h.text}` : transcriptReply(h.text)))
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

  // ---------------- 관리자 점검용: 시나리오 고르기 ----------------
  // 서버(/interview/ai/start)가 관리자 토큰일 때만 scenarioId 를 받는다. 여기서 보이게 하는 것은 편의일 뿐이다.
  const scenarioWrap = $("ivScenarioWrap");
  const scenarioSelect = $("ivScenario");
  const backendWrap = $("ivBackendWrap");
  const backendSelect = $("ivBackend");
  let adminOn = false;
  let scenarioReq = 0;
  // 관리자 점검용 칸은 숨기는 데 그치지 않고 학생 계정에서는 문서에서 떼낸다 (관리자 탭과 같은 방식).
  // 다시 붙일 수 있게 원래 자리(다음 형제)를 기억해 둔다.
  const adminFields = [scenarioWrap, backendWrap].filter(Boolean).map((el) => ({ el, parent: el.parentElement, next: el.nextSibling }));
  function placeAdminFields(on) {
    // 뒤의 칸부터 붙인다 — 앞 칸의 기준(다음 형제)이 뒤 칸이라, 그 칸이 먼저 문서에 있어야 한다.
    for (const f of [...adminFields].reverse()) {
      if (on && !f.el.isConnected) f.parent.insertBefore(f.el, f.next);
      else if (!on && f.el.isConnected) f.el.remove();
    }
  }
  placeAdminFields(false);
  async function loadScenarios() {
    if (!scenarioWrap || !scenarioSelect) return;
    const myReq = ++scenarioReq; // 주제를 빠르게 바꾸면 늦게 온 이전 응답이 새 목록에 섞이지 않게 한다
    scenarioSelect.innerHTML = '<option value="">무작위</option>';
    const topic = topicSelect.value;
    scenarioWrap.classList.toggle("hidden", !(adminOn && topic));
    if (!adminOn || !topic) return;
    try {
      const data = await callWorker("/interview/ai/scenarios", { topic }, { withAuth: true });
      if (myReq !== scenarioReq) return;
      for (const s of data.scenarios || []) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.dx} (${s.id})`;
        scenarioSelect.appendChild(opt);
      }
    } catch (err) {
      console.warn("시나리오 목록 실패", err?.data?.error || err?.message);
      scenarioWrap.classList.add("hidden");
    }
  }
  topicSelect.addEventListener("change", loadScenarios);
  return {
    setAdmin(on) {
      adminOn = !!on;
      placeAdminFields(adminOn);
      backendWrap?.classList.toggle("hidden", !adminOn);
      if (!adminOn && backendSelect) backendSelect.value = "";
      loadScenarios();
    },
  };
}
