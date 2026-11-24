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
