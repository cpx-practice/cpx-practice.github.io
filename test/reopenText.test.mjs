import { test } from "node:test";
import assert from "node:assert/strict";
import { reopenText } from "../docs/export.js";

const now = new Date("2026-11-24T01:30:00Z"); // 한국 10:30
test("다시 열리는 시각을 한국 시간으로 말한다", () => {
  assert.equal(reopenText("2026-11-24T15:00:00.000Z", now), "오늘 밤 12시쯤 다시 열립니다.");
  assert.equal(reopenText("2026-11-24T05:20:00.000Z", now), "오늘 오후 3시쯤 다시 열립니다.");
  assert.equal(reopenText("2026-11-25T00:00:00.000Z", now), "내일 오전 9시쯤 다시 열립니다.");
  assert.equal(reopenText("2026-11-24T11:00:00.000Z", now), "오늘 저녁 8시쯤 다시 열립니다.");
  assert.equal(reopenText("", now), "잠시 후 다시 열립니다.");
  assert.equal(reopenText("2026-11-24T01:00:00.000Z", now), "잠시 후 다시 열립니다.");
});

import { freeCountText } from "../docs/export.js";
test("내 오늘 사용 횟수로 남은 면담을 말한다", () => {
  assert.equal(freeCountText({ canStart: true, mine: { usedToday: 2, limit: 5 } }), "오늘 무료 면담 3/5회 남음");
  assert.equal(freeCountText({ canStart: true, mine: { usedToday: 5, limit: 5 } }), "오늘 무료 면담 5회를 모두 썼습니다 · 오전 9시에 다시 열립니다");
  assert.equal(freeCountText({ canStart: true, mine: { usedToday: 1, limit: null } }), null); // 관리자
  assert.equal(freeCountText({ canStart: true }), null); // 로그인 전
  assert.equal(freeCountText({ canStart: false, mine: { usedToday: 0, limit: 5 } }), null); // 공용 한도 소진은 원래 문구
});
