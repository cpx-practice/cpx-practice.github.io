// 웹 면담 채점 보정 테스트.  cd cpx-tracker && node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { auditMarks, reconcileNarrative, scoreRecord } from "../docs/scoring.js";

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

test("설명 줄 앞에 번호·목록 기호·굵은 글씨가 붙어 있어도 맞춘다 (실제 모델 출력은 번호 목록이었다)", () => {
  const changes = [{ label: "진찰 전 설명·동의", from: "O", to: "△", reason: "x" }];
  const history = [u("어떤 병인지 짐작하시는 게 있나요? 걱정되는 건 뭔가요?"), u("어떤 도움을 기대하세요?")];
  const record = { marks: { ice: "O" } };
  for (const lead of ["1. ", "2) ", "- ", "* ", "• ", "  - ", "**"]) {
    const bold = lead === "**";
    const consentLine = bold ? "**진찰 전 설명·동의**: O (통보)" : `${lead}진찰 전 설명·동의: O ("진찰을 시작하겠습니다")`;
    const iceLine = bold ? "**ICE**: O (원인에 대한 질문은 없었으나)" : `${lead}ICE: O (원인에 대한 질문은 없었으나)`;
    const out = reconcileNarrative(`${consentLine}\n${iceLine}\n`, record, history, changes);
    assert.match(out, /진찰 전 설명·동의\**: △ /, `동의 줄 (${JSON.stringify(lead)})`);
    assert.match(out, /ICE\**: O \(생각·걱정·기대를 모두 질문함\)/, `ICE 줄 (${JSON.stringify(lead)})`);
  }
});

test("해당없음(N)은 신체진찰 항목에서만 만점이고, 병력청취·PPI 에서는 △ 로 본다", () => {
  const marks = { ...allO(), language: "N", summary: "N", hpi: "N" };
  const s = scoreRecord({ marks });
  const row = (label) => s.rows.find((r) => r.label === label);
  assert.equal(row("언어사용").mark, "△");
  assert.equal(row("언어사용").got, 1);
  assert.equal(row("요약·확인").got, 2);
  assert.equal(row("주호소&현병력").got, 10);

  // 신체진찰이 없는 케이스: 진찰 항목 전부 N 이면 20점 만점
  const noPe = scoreRecord({ marks: { ...allO(), consent: "N", vitals: "N", pe1: "N", pe2: "N" } });
  assert.equal(noPe.pe, 20);
  // 핵심 수기가 1개뿐인 케이스: pe2 N → 수기 1 에 12점
  const onePe = scoreRecord({ marks: { ...allO(), pe2: "N" } });
  assert.equal(onePe.pe, 20);
});
