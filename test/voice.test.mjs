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
