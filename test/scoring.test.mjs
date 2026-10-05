// 웹 면담 채점 보정 테스트.  cd cpx-tracker && node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditMarks, reconcileNarrative } from "../docs/scoring.js";

const u = (text) => ({ role: "user", text });
const a = (text) => ({ role: "assistant", text });
const allO = () => ({ intro: "O", hpi: "O", ice: "O", redflag: "O", pmh: "O", safety: "O", consent: "O", vitals: "O", pe1: "O", pe2: "O", rapport: "O", order: "O", empathy: "O", summary: "O", language: "O", closing: "O" });
const consentOf = (turns) => {
  const record = { topic: "발열", marks: allO() };
  const changes = auditMarks(record, turns.map((t) => (typeof t === "string" ? u(t) : t)));
  return { mark: record.marks.consent, changes: changes.filter((c) => c.label === "진찰 전 설명·동의") };
};
const base = ["안녕하세요, 저는 담당 의사 김하늘입니다. 성함과 나이를 말씀해 주시겠어요?"];

test("진찰 전 동의: 통보만 하면 △, 구체적 설명과 안내가 같이 있으면 O 를 유지한다", () => {
  const bare = consentOf([...base, "정리하면 열이 나는 것이 맞죠? 진찰을 시작하겠습니다.", "진찰", "(복부를 촉진한다)"]);
  assert.equal(bare.mark, "△");
  assert.match(bare.changes[0].reason, /구체적인 설명 없음/);

  const full = consentOf([...base, "손을 씻고 설명드린 뒤 혈압과 체온을 측정하겠습니다. 아프면 말씀해 주세요.", "진찰", "(복부를 촉진한다)"]);
  assert.equal(full.mark, "O");

  const permitOnly = consentOf([...base, "진찰을 해도 될까요?", "진찰", "(복부를 촉진한다)"]);
  assert.equal(permitOnly.mark, "△");

  const specificOnly = consentOf([...base, "혈압과 체온을 측정하겠습니다.", "진찰", "(복부를 촉진한다)"]);
  assert.equal(specificOnly.mark, "△");
  assert.match(specificOnly.changes[0].reason, /안내 없음/);
});

test("진찰 전 동의: 말이 전혀 없으면 X", () => {
  assert.equal(consentOf([...base, "열은 언제부터 났나요?", "진찰", "(복부를 촉진한다)"]).mark, "X");
});

test("ICE: 모두 물었는데 설명이 '질문 없었다'고 쓰면 확인된 사실로 바꾼다", () => {
  const history = [u("어떤 병인지 짐작하시는 게 있나요? 가장 걱정되는 건 뭔가요?"), a("걱정돼요"), u("어떤 도움을 기대하고 오셨나요?")];
  const record = { topic: "발열", marks: { ice: "O" } };
  const shown = "도입: O (자기소개)\nICE: O (원인에 대한 질문은 없었으나, 걱정과 기대에 대해 명확히 질문함)\n";
  const out = reconcileNarrative(shown, record, history, []);
  assert.match(out, /^ICE: O \(생각·걱정·기대를 모두 질문함\)$/m);
  assert.match(out, /^도입: O \(자기소개\)$/m);
});

test("ICE: 하나라도 안 물었으면 설명을 건드리지 않는다", () => {
  const history = [u("가장 걱정되는 건 뭔가요?")];
  const record = { topic: "발열", marks: { ice: "O" } };
  const shown = "ICE: O (원인에 대한 질문은 없었으나 …)\n";
  assert.equal(reconcileNarrative(shown, record, history, []), shown);
});

test("낮춘 항목은 설명 줄의 표시도 같이 낮춘다", () => {
  const changes = [
    { label: "ICE (환자의 생각·걱정·기대)", from: "O", to: "△", reason: "기대 질문 없음" },
    { label: "진찰 전 설명·동의", from: "O", to: "△", reason: "x" },
  ];
  const shown = "ICE: O (생각, 걱정)\n진찰 전 설명·동의: O (시작하겠습니다)\n마무리 인사: O\n";
  const out = reconcileNarrative(shown, { marks: {} }, [], changes);
  assert.match(out, /^ICE: △ \(생각, 걱정\)$/m);
  assert.match(out, /^진찰 전 설명·동의: △ /m);
  assert.match(out, /^마무리 인사: O$/m);
});
