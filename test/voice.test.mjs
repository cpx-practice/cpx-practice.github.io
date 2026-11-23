import { test } from "node:test";
import assert from "node:assert/strict";
import { speakableText } from "../docs/voice.js";

test("환자 목소리는 환자 말만 읽는다 — 괄호 서술·진찰 소견·이모지는 빼고", () => {
  assert.equal(speakableText("어제부터 배가 아파요."), "어제부터 배가 아파요.");
  assert.equal(speakableText("(배를 움켜쥐며) 여기가 제일 아파요."), "여기가 제일 아파요.");
  assert.equal(speakableText("(복부 촉진: 우하복부 압통이 있다)"), "");
  assert.equal(speakableText("(혈압 124/70 mmHg, 맥박 79회/분)"), "");
  assert.equal(speakableText("🚪 환자가 나갔습니다"), "환자가 나갔습니다");
  assert.equal(speakableText("네,\n맞아요.  "), "네, 맞아요.");
});

import { voiceSex, chooseVoice } from "../docs/voice.js";

const V = (name) => ({ name, lang: "ko-KR", voiceURI: name });
const heami = V("Microsoft Heami - Korean (Korean)");
const sunhi = V("Microsoft SunHi Online (Natural) - Korean (Korea)");
const injoon = V("Microsoft InJoon Online (Natural) - Korean (Korea)");
const hyunsu = V("Microsoft Hyunsu Multilingual Online (Natural) - Korean (Korea)");
const googleKo = V("Google 한국의");

test("voiceSex: 알려진 이름으로 성별을 가른다", () => {
  assert.equal(voiceSex(heami), "female");
  assert.equal(voiceSex(googleKo), "female");
  assert.equal(voiceSex(injoon), "male");
  assert.equal(voiceSex(hyunsu), "male");
  assert.equal(voiceSex(V("ko-kr-x-kod-local")), "male");
  assert.equal(voiceSex(V("ko-kr-x-ism-local")), "female");
  assert.equal(voiceSex(V("한국어 대한민국")), null);
});

test("chooseVoice: 같은 성별 목소리를 고르고, 여럿이면 돌아가며", () => {
  const all = [heami, sunhi, injoon, hyunsu, googleKo];
  const r0 = () => 0, r9 = () => 0.99;
  assert.equal(chooseVoice(all, { sex: "male", age: 40 }, r0).voice, injoon);
  assert.equal(chooseVoice(all, { sex: "male", age: 40 }, r9).voice, hyunsu);
  assert.equal(chooseVoice(all, { sex: "female", age: 40 }, r0).voice, sunhi); // Natural 우선
  const t = chooseVoice(all, { sex: "male", age: 40 }, () => 0.5);
  assert.equal(t.pitch, 1);
  assert.equal(t.rate, 1);
});

test("chooseVoice: 남성 목소리가 없으면 여성 목소리를 낮춰 쓴다", () => {
  const t = chooseVoice([heami], { sex: "male", age: 45 }, () => 0.5);
  assert.equal(t.voice, heami);
  assert.ok(t.pitch <= 0.65, String(t.pitch));
  const f = chooseVoice([heami], { sex: "female", age: 45 }, () => 0.5);
  assert.equal(f.pitch, 1);
});

test("chooseVoice: 노인은 조금 낮고 느리게, 정보가 없으면 기본", () => {
  const old = chooseVoice([heami], { sex: "female", age: 78 }, () => 0.5);
  assert.ok(old.pitch < 1 && old.rate < 1);
  const none = chooseVoice([heami], null, () => 0.5);
  assert.deepEqual([none.voice, none.pitch, none.rate], [heami, 1, 1]);
  assert.equal(chooseVoice([], { sex: "male" }), null);
});
