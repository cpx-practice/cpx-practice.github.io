// 계정별 AI 키 보관 로직 테스트.  cd cpx-tracker && node --test test/aikeys.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KEY_PROVIDERS, pickKnown, claimConfig, mergeCloud, cloudPayload } from "../docs/aikeys.js";

test("허용된 제공자의 알맞은 문자열만 남긴다", () => {
  assert.deepEqual(pickKnown({ gemini: " abc ", openai: "", anthropic: 5, evil: "x", openrouter: "k".repeat(401) }), { gemini: "abc" });
  assert.deepEqual(pickKnown(null), {});
  assert.deepEqual(KEY_PROVIDERS, ["gemini", "openai", "anthropic", "openrouter"]);
});

test("다른 계정의 설정이 남아 있으면 비우고, 주인 표시가 없는 예전 설정은 지금 계정의 것으로 본다", () => {
  const other = claimConfig({ provider: "openai", keys: { openai: "sk-other" }, models: { openai: "m" }, cloud: true, ownerUid: "A" }, "B");
  assert.deepEqual(other, { provider: "free", keys: {}, models: {}, cloud: false, ownerUid: "B" });

  const legacy = claimConfig({ provider: "gemini", keys: { gemini: "g" }, models: {} }, "B");
  assert.equal(legacy.ownerUid, "B");
  assert.equal(legacy.keys.gemini, "g");

  const mine = claimConfig({ provider: "openai", keys: { openai: "sk" }, models: {}, ownerUid: "B" }, "B");
  assert.equal(mine.keys.openai, "sk");

  assert.deepEqual(claimConfig(null, "B").keys, {});
});

test("계정에 저장된 키를 합친다 — 같은 제공자는 계정 쪽이 이기고, 새 기기면 제공자도 따라간다", () => {
  const fresh = mergeCloud({ provider: "free", keys: {}, models: {} }, { aiKeys: { openai: "sk-cloud" }, aiModels: { openai: "gpt-x" }, aiProvider: "openai" });
  assert.equal(fresh.provider, "openai");
  assert.equal(fresh.keys.openai, "sk-cloud");
  assert.equal(fresh.models.openai, "gpt-x");
  assert.equal(fresh.cloud, true);

  // 이 기기에 이미 키가 있으면 사용자가 고른 제공자를 바꾸지 않는다
  const used = mergeCloud({ provider: "gemini", keys: { gemini: "g-local", openai: "old" }, models: {} }, { aiKeys: { openai: "sk-cloud" }, aiProvider: "openai" });
  assert.equal(used.provider, "gemini");
  assert.equal(used.keys.gemini, "g-local");
  assert.equal(used.keys.openai, "sk-cloud");
});

test("계정 문서에 이상한 값이 있어도 걸러서 합친다", () => {
  const m = mergeCloud({ provider: "free", keys: {}, models: {} }, { aiKeys: { evil: "x", anthropic: "a" }, aiProvider: "nonsense" });
  assert.deepEqual(m.keys, { anthropic: "a" });
  assert.equal(m.provider, "free");
  assert.deepEqual(mergeCloud({ provider: "free", keys: {}, models: {} }, undefined).keys, {});
});

test("계정에 올릴 내용은 허용된 항목만, 제공자가 이상하면 free 로", () => {
  assert.deepEqual(cloudPayload({ provider: "openai", keys: { openai: "sk", junk: "x" }, models: { openai: "m" } }), {
    aiKeys: { openai: "sk" },
    aiModels: { openai: "m" },
    aiProvider: "openai",
  });
  assert.equal(cloudPayload({ provider: "weird", keys: {}, models: {} }).aiProvider, "free");
  assert.deepEqual(cloudPayload(undefined), { aiKeys: {}, aiModels: {}, aiProvider: "free" });
});
