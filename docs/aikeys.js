// 면담 탭의 AI 설정(제공자·키·모델)을 계정에 맞춰 다루는 순수 함수들. 화면·Firestore 를 모르므로 노드에서 그대로 검증한다.
//
// 키는 기본적으로 브라우저(localStorage)에만 있다. 사용자가 "내 계정에 키 저장"을 켜면 userSecrets/{uid} 에도 둔다
// (firestore.rules 가 본인만 읽고 쓰게 막는다 — 관리자도 앱에서는 읽지 못한다).

// firestore.rules 의 userSecrets 규칙이 허용하는 제공자와 같아야 한다. "free"(키 없음)는 저장할 키가 없다.
export const KEY_PROVIDERS = ["gemini", "openai", "anthropic", "openrouter"];
const MAX_VALUE_CHARS = 400; // API 키·모델 이름보다 훨씬 넉넉하다 — 엉뚱한 긴 글을 계정에 올리지 않는 안전장치

/** {제공자: 문자열} 에서 허용된 제공자와 알맞은 문자열만 남긴다. */
export function pickKnown(obj) {
  const out = {};
  for (const id of KEY_PROVIDERS) {
    const v = obj && typeof obj[id] === "string" ? obj[id].trim() : "";
    if (v && v.length <= MAX_VALUE_CHARS) out[id] = v;
  }
  return out;
}

/**
 * 이 브라우저에 저장된 설정이 지금 로그인한 계정의 것인지 맞춘다.
 * 주인이 다른 계정이면 키·모델을 비운다 — 한 브라우저를 여러 사람이 쓸 때 서로의 키를 쓰지 않게.
 * 주인 표시가 없는 예전 설정은 지금 계정의 것으로 본다.
 */
export function claimConfig(config, uid) {
  const c = config || {};
  if (c.ownerUid && c.ownerUid !== uid) {
    return { provider: "free", keys: {}, models: {}, cloud: false, ownerUid: uid };
  }
  return { ...c, keys: c.keys || {}, models: c.models || {}, ownerUid: uid };
}

/**
 * 계정에 저장된 설정(userSecrets 문서 data)을 로컬 설정에 합친다. 같은 제공자는 계정 쪽이 이긴다.
 * 이 기기에 키가 하나도 없으면(새 기기) 계정에 저장해 둔 제공자도 그대로 쓴다.
 */
export function mergeCloud(config, data) {
  const c = config || {};
  const freshDevice = Object.keys(c.keys || {}).length === 0;
  const provider = freshDevice && (data?.aiProvider === "free" || KEY_PROVIDERS.includes(data?.aiProvider)) ? data.aiProvider : c.provider;
  return {
    ...c,
    provider,
    keys: { ...(c.keys || {}), ...pickKnown(data?.aiKeys) },
    models: { ...(c.models || {}), ...pickKnown(data?.aiModels) },
    cloud: true,
  };
}

/** 계정에 올릴 내용. updatedAt 은 호출하는 쪽이 서버 시각으로 붙인다. */
export function cloudPayload(config) {
  return {
    aiKeys: pickKnown(config?.keys),
    aiModels: pickKnown(config?.models),
    aiProvider: config?.provider === "free" || KEY_PROVIDERS.includes(config?.provider) ? config.provider : "free",
  };
}
