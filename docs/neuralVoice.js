// 고품질 환자 목소리 — Supertonic 2 음성 모델을 학생 브라우저 안에서 돌린다 (서버·AI 한도와 무관).
//   모델(약 263MB)은 Hugging Face 에서 한 번 받아 브라우저 저장소(Cache Storage)에 둔다. 다음부터는 받지 않는다.
//   WebGPU 가 있는 기기에서만 쓴다 — CPU(WASM)만으로는 휴대폰에서 답 하나에 수 초 이상 걸린다.
//   길이 예측 모델(duration_predictor)은 WebGPU 에서 길이를 1.6배로 잘못 내서(문장 중간 1초 공백) CPU 로 돌린다.
// 목소리 10개: F1~F5(여), M1~M5(남). 가중치 라이선스 OpenRAIL-M — 화면에 "AI 합성 음성"으로 밝힌다.

const REPO = "https://huggingface.co/Supertone/supertonic-2/resolve/75e6727618a02f323c720cba9478152d4bc16ca4";
const CACHE = "cpx-voice-supertonic2-75e6727";
const MODELS = [
  // [파일, 대략 크기(바이트) — 진행률 표시용, 실행 장치]
  ["onnx/duration_predictor.onnx", 1521526, "wasm"],
  ["onnx/text_encoder.onnx", 27431318, "webgpu"],
  ["onnx/vector_estimator.onnx", 132471364, "webgpu"],
  ["onnx/vocoder.onnx", 101405066, "webgpu"],
];
const JSONS = ["onnx/tts.json", "onnx/unicode_indexer.json"];
export const NEURAL_MB = 263;
export const NEURAL_VOICES = { female: ["F1", "F2", "F3", "F4", "F5"], male: ["M1", "M2", "M3", "M4", "M5"] };

let state = "idle"; // idle | loading | ready | failed
let loading = null;
let engine = null; // { tts, lib }
const styles = new Map();

export function neuralState() {
  return state;
}

/** WebGPU 를 실제로 쓸 수 있는지 (어댑터까지 받아 본다). */
export async function hasWebGPU() {
  try {
    if (!navigator.gpu) return false;
    return !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

/** 모델이 이미 브라우저에 다 받아져 있는지 — 데이터 요금 걱정 없이 바로 켤 수 있는지 볼 때 쓴다. */
export async function neuralCached() {
  try {
    const c = await caches.open(CACHE);
    for (const [f] of MODELS) if (!(await c.match(`${REPO}/${f}`))) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchCached(path, onBytes) {
  const url = `${REPO}/${path}`;
  let cache = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      onBytes && onBytes(buf.byteLength);
      return buf;
    }
  } catch {
    cache = null; // 저장소를 못 쓰는 브라우저(사생활 보호 창 등) — 매번 받는다
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`voice_model_${res.status}`);
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    onBytes && onBytes(value.byteLength);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  if (cache) {
    try {
      await cache.put(url, new Response(out, { headers: { "Content-Type": "application/octet-stream" } }));
    } catch {
      /* 저장 공간이 모자라면 이번만 쓴다 */
    }
  }
  return out.buffer;
}

/** 모델을 받아(또는 저장소에서 꺼내) 준비한다. onProgress(0~1). 여러 번 불러도 한 번만 받는다. */
export function loadNeural(onProgress) {
  if (loading) return loading;
  state = "loading";
  const total = MODELS.reduce((s, m) => s + m[1], 0);
  let done = 0;
  const tick = (n) => {
    done += n;
    onProgress && onProgress(Math.min(1, done / total));
  };
  loading = (async () => {
    try {
      navigator.storage?.persist?.().catch(() => {}); // 브라우저가 저장소를 함부로 비우지 않게 요청만 해 둔다
    } catch {
      /* 무시 */
    }
    const lib = await import("./vendor/supertonic.js");
    const [cfgBuf, idxBuf] = await Promise.all(JSONS.map((f) => fetchCached(f)));
    const dec = new TextDecoder();
    const cfgs = JSON.parse(dec.decode(cfgBuf));
    const indexer = JSON.parse(dec.decode(idxBuf));
    const sessions = [];
    for (const [f, , ep] of MODELS) {
      const buf = await fetchCached(f, tick);
      sessions.push(await lib.ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: [ep], logSeverityLevel: 3 }));
    }
    const tts = new lib.TextToSpeech(cfgs, new lib.UnicodeProcessor(indexer), ...sessions);
    engine = { tts, lib };
    // 첫 문장은 GPU 준비 때문에 1~2초 더 걸린다 — 환자 첫 답이 늦지 않게 미리 한 번 돌려 둔다.
    // ready 로 바꾸기 전에 해야 실제 답과 겹쳐 돌지 않는다 (겹치면 "Session already started").
    try {
      await runSynth("네.", "F1", 1.05);
    } catch {
      /* 준비 실패여도 실제 말할 때 다시 시도한다 */
    }
    state = "ready";
    return true;
  })().catch((err) => {
    console.warn("고품질 목소리 준비 실패", err);
    state = "failed";
    loading = null;
    return false;
  });
  return loading;
}

async function styleOf(id) {
  if (styles.has(id)) return styles.get(id);
  const { lib } = engine;
  const j = JSON.parse(new TextDecoder().decode(await fetchCached(`voice_styles/${id}.json`)));
  const t = (o) => new lib.ort.Tensor("float32", Float32Array.from(o.data.flat(Infinity)), o.dims);
  const s = new lib.Style(t(j.style_ttl), t(j.style_dp));
  styles.set(id, s);
  return s;
}

/** 면담마다 말하는 사람 성별에 맞는 목소리 하나를 무작위로. 성별을 모르면 아무거나. */
export function pickNeuralVoice(speaker, rand = Math.random) {
  const pool = speaker && NEURAL_VOICES[speaker.sex] ? NEURAL_VOICES[speaker.sex] : [...NEURAL_VOICES.female, ...NEURAL_VOICES.male];
  return pool[Math.floor(rand() * pool.length) % pool.length];
}

/** 말하는 빠르기 — 노인은 조금 느리게, 나머지는 사람마다 조금씩. */
export function neuralSpeed(speaker, rand = Math.random) {
  const age = Number(speaker && speaker.age);
  const base = age >= 70 ? 0.92 : age >= 60 ? 0.98 : 1.05;
  return Math.round((base + (rand() - 0.5) * 0.08) * 100) / 100;
}

/** 글을 소리(WAV Blob)로. { blob, audioSec, genSec } */
export async function synthNeural(text, voiceId, speed = 1.05) {
  if (state !== "ready") throw new Error("voice_not_ready");
  return runSynth(text, voiceId, speed);
}

async function runSynth(text, voiceId, speed) {
  const { tts, lib } = engine;
  const style = await styleOf(voiceId);
  const t0 = performance.now();
  const { wav, duration } = await tts.call(text, "ko", style, 5, speed, 0.3);
  const genSec = (performance.now() - t0) / 1000;
  const n = Math.min(wav.length, Math.floor(tts.sampleRate * duration[0]));
  const blob = new Blob([lib.writeWavFile(wav.slice(0, n), tts.sampleRate)], { type: "audio/wav" });
  return { blob, audioSec: duration[0], genSec };
}
