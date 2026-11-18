// 면담 음성 — 말로 묻기(음성 인식)와 환자 답 읽어 주기(음성 합성).
// 브라우저 내장 Web Speech API 만 쓴다. 소리는 학생 기기에서 처리되고 서버·AI 한도와 무관하다.
//   음성 인식: 크롬·엣지·안드로이드·사파리(webkit 접두사). 파이어폭스는 없다 → 마이크 버튼을 숨긴다.
//   음성 합성: 대부분의 브라우저. 한국어 목소리가 없는 기기에서는 켜기 칸을 숨긴다.
// 인식 결과는 바로 보내지 않고 입력창에 넣는다 — 의학 용어를 잘못 받아 적을 수 있어 학생이 확인하고 보낸다.

const TTS_KEY = "cpx.iv.tts";

function loadPref() {
  try {
    return localStorage.getItem(TTS_KEY) === "1";
  } catch {
    return false;
  }
}
function savePref(on) {
  try {
    localStorage.setItem(TTS_KEY, on ? "1" : "0");
  } catch {
    /* 저장 못 해도 이번 화면에서는 동작한다 */
  }
}

// 환자 말만 읽는다. 진찰 소견·행동 묘사처럼 괄호로 쓴 서술과 이모지는 소리로 내지 않는다.
export function speakableText(text) {
  return String(text || "")
    .replace(/\([^()]*\)/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function initVoice({ input, micButton, ttsToggle, ttsWrap, onStatus }) {
  const status = (msg) => onStatus && onStatus(msg);
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;

  // ---------------- 음성 합성 ----------------
  let voice = null;
  let ttsOn = false;
  function pickVoice() {
    if (!synth) return null;
    const ko = synth.getVoices().filter((v) => /^ko(-|_|$)/i.test(v.lang));
    // 기기에 있는 한국어 목소리 중 자연스러운 쪽(이름에 Natural·Neural·Google 이 붙은 것)을 먼저 고른다.
    return ko.find((v) => /natural|neural|google/i.test(v.name)) || ko[0] || null;
  }
  function refreshVoice() {
    voice = pickVoice();
    if (ttsWrap) ttsWrap.classList.toggle("hidden", !voice);
  }
  if (synth && ttsToggle) {
    refreshVoice();
    // 크롬은 목소리 목록을 나중에 채운다.
    synth.addEventListener?.("voiceschanged", refreshVoice);
    ttsOn = loadPref();
    ttsToggle.checked = ttsOn;
    ttsToggle.addEventListener("change", () => {
      ttsOn = ttsToggle.checked;
      savePref(ttsOn);
      if (!ttsOn) stopSpeaking();
    });
  } else if (ttsWrap) {
    ttsWrap.classList.add("hidden");
  }

  function stopSpeaking() {
    try {
      synth?.cancel();
    } catch {
      /* 무시 */
    }
  }
  function speak(text) {
    if (!ttsOn || !synth || !voice) return;
    const t = speakableText(text);
    if (!t) return;
    stopSpeaking();
    const u = new SpeechSynthesisUtterance(t);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 1;
    synth.speak(u);
  }

  // ---------------- 음성 인식 ----------------
  let rec = null;
  let listening = false;
  let base = "";
  if (!Rec || !micButton) {
    micButton?.classList.add("hidden");
  } else {
    micButton.addEventListener("click", () => (listening ? stopListening() : startListening()));
  }

  function setMic(on) {
    listening = on;
    micButton.classList.toggle("listening", on);
    micButton.setAttribute("aria-pressed", on ? "true" : "false");
    micButton.title = on ? "말하기 끝내기" : "말로 입력하기";
  }

  function startListening() {
    stopSpeaking(); // 환자 목소리가 마이크로 다시 들어가지 않게
    base = input.value ? input.value.replace(/\s*$/, " ") : "";
    rec = new Rec();
    rec.lang = "ko-KR";
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      input.value = (base + text).replace(/\s+/g, " ").trimStart();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") status("마이크 사용이 허용되지 않았습니다. 브라우저 주소창의 마이크 권한을 확인해주세요.");
      else if (e.error === "no-speech") status("말소리가 들리지 않았습니다. 다시 눌러 말해 주세요.");
      else if (e.error !== "aborted") status("음성 인식에 실패했습니다 (" + e.error + "). 글자로 입력해 주세요.");
    };
    rec.onend = () => {
      setMic(false);
      rec = null;
      if (input.value.trim()) {
        status("말한 내용을 확인하고 보내기를 누르세요.");
        input.focus();
      }
    };
    try {
      rec.start();
      setMic(true);
      status("듣고 있습니다… 말을 마치면 마이크를 다시 누르세요.");
    } catch (err) {
      setMic(false);
      status("음성 인식을 시작하지 못했습니다. 글자로 입력해 주세요.");
      console.warn("음성 인식 시작 실패", err);
    }
  }
  function stopListening() {
    try {
      rec?.stop();
    } catch {
      /* 무시 */
    }
  }

  return {
    speak,
    // 학생이 말을 보내거나 면담을 나갈 때 — 읽던 것과 듣던 것을 모두 멈춘다.
    stop() {
      stopSpeaking();
      if (listening) stopListening();
    },
  };
}
