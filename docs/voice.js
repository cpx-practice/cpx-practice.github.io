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

// 브라우저는 목소리의 성별을 알려 주지 않는다 — 알려진 한국어 목소리 이름으로 가른다.
//   Windows·Edge: Heami·SunHi·JiMin·SeoHyeon·SoonBok·YuJin(여) / InJoon·Hyunsu·BongJin·GookMin(남)
//   크롬: "Google 한국의"(여) · 애플: Yuna·Sora·Suhyun·Narae(여) / Minsu·Jian(남)
//   안드로이드 구글 TTS: ko-kr-x-ism·kob(여) / koc·kod(남)
const FEMALE_VOICE = /heami|sunhi|jimin|seohyeon|soonbok|yujin|yuna|sora|suhyun|narae|google|x-ism|x-kob|female|여성|여자/i;
const MALE_VOICE = /injoon|hyunsu|bongjin|gookmin|minsu|jian|x-koc|x-kod|(?<!fe)male|남성|남자/i;

export function voiceSex(v) {
  const id = `${v.name || ""} ${v.voiceURI || ""}`;
  if (MALE_VOICE.test(id)) return "male";
  if (FEMALE_VOICE.test(id)) return "female";
  return null;
}

const NATURAL = /natural|neural|online|enhanced|premium/i;

/**
 * 말하는 사람에 맞는 목소리와 높낮이·빠르기를 고른다. 같은 성별 목소리가 여럿이면 면담마다 무작위로.
 * 맞는 성별 목소리가 기기에 없으면 있는 목소리의 높낮이를 바꿔 비슷하게 낸다 (여 → 남: 낮게).
 * rand 는 시험용.
 */
export function chooseVoice(voices, speaker, rand = Math.random) {
  if (!voices || !voices.length) return null;
  const sex = speaker && speaker.sex;
  const age = speaker && Number(speaker.age);
  const same = sex ? voices.filter((v) => voiceSex(v) === sex) : [];
  const pool = same.length ? same : voices;
  // 자연스러운 목소리(Natural·Online 등)가 있으면 그중에서 고른다.
  const nice = pool.filter((v) => NATURAL.test(v.name));
  const from = nice.length ? nice : pool;
  const voice = from[Math.floor(rand() * from.length) % from.length];

  let pitch = 1;
  const actual = voiceSex(voice);
  if (sex && actual && actual !== sex) pitch = sex === "male" ? 0.6 : 1.3; // 맞는 성별이 없을 때
  else if (sex && !actual) pitch = sex === "male" ? 0.75 : 1.1;
  let rate = 1;
  if (age >= 70) { pitch -= 0.1; rate = 0.88; }
  else if (age >= 60) { pitch -= 0.05; rate = 0.94; }
  else if (age > 0 && age < 13) pitch += 0.25;
  // 같은 목소리라도 사람마다 조금씩 다르게 들리도록
  pitch += (rand() - 0.5) * 0.12;
  rate += (rand() - 0.5) * 0.08;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Math.round(x * 100) / 100));
  return { voice, pitch: clamp(pitch, 0.5, 1.6), rate: clamp(rate, 0.8, 1.15) };
}

export function initVoice({ input, micButton, ttsToggle, ttsWrap, onStatus }) {
  const status = (msg) => onStatus && onStatus(msg);
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;

  // ---------------- 음성 합성 ----------------
  let voices = []; // 기기에 있는 한국어 목소리
  let speaker = null; // 이번 면담에서 말하는 사람 { sex, age } — 서버가 준다
  let tone = null; // 이번 면담의 목소리 { voice, pitch, rate }
  let ttsOn = false;
  function refreshVoices() {
    voices = synth ? synth.getVoices().filter((v) => /^ko(-|_|$)/i.test(v.lang)) : [];
    // 면담 중에 목록이 다시 채워져도 고른 목소리는 그대로 둔다 (중간에 목소리가 바뀌지 않게).
    if (!tone || !voices.includes(tone.voice)) tone = voices.length ? chooseVoice(voices, speaker) : null;
    if (ttsWrap) ttsWrap.classList.toggle("hidden", !voices.length);
  }
  if (synth && ttsToggle) {
    refreshVoices();
    // 크롬은 목소리 목록을 나중에 채운다.
    synth.addEventListener?.("voiceschanged", refreshVoices);
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
    if (!ttsOn || !synth || !tone) return;
    const t = speakableText(text);
    if (!t) return;
    stopSpeaking();
    const u = new SpeechSynthesisUtterance(t);
    u.voice = tone.voice;
    u.lang = tone.voice.lang;
    u.pitch = tone.pitch;
    u.rate = tone.rate;
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
    // 면담을 시작할 때 — 말하는 사람의 성별·나이에 맞춰 이번 면담의 목소리를 새로 고른다.
    setSpeaker(next) {
      speaker = next && (next.sex === "male" || next.sex === "female") ? next : null;
      tone = voices.length ? chooseVoice(voices, speaker) : null;
    },
    // 학생이 말을 보내거나 면담을 나갈 때 — 읽던 것과 듣던 것을 모두 멈춘다.
    stop() {
      stopSpeaking();
      if (listening) stopListening();
    },
  };
}
