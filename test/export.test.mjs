// 기록 상세·내보내기 보정 테스트.  cd cpx-tracker && node --test test/export.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimTranscript, tabulateEvaluation, recordToMarkdown } from "../docs/export.js";

test("전사: '평가' 입력과 그 뒤 채점문은 잘라 낸다", () => {
  const script = [
    "의사: 안녕하세요",
    "환자: 네",
    "의사: 진찰",
    "환자: (혈압 120/80 mmHg)",
    "의사: 평가",
    "환자: ## I. 병력청취\n1. 도입 (5점): O (자기소개)",
  ].join("\n\n");
  const out = trimTranscript(script);
  assert.equal(out, "의사: 안녕하세요\n\n환자: 네\n\n의사: 진찰\n\n환자: (혈압 120/80 mmHg)");
  assert.ok(!out.includes("평가") && !out.includes("도입"));
});

test("전사: 평가 신호가 없거나, 문진 중 '평가'라는 낱말이 나와도 건드리지 않는다", () => {
  const plain = "의사: 안녕하세요\n\n환자: 네";
  assert.equal(trimTranscript(plain), plain);
  const word = "의사: 이전 병원에서 평가는 어땠나요?\n\n환자: 괜찮았어요";
  assert.equal(trimTranscript(word), word);
  assert.equal(trimTranscript(""), "");
  assert.equal(trimTranscript(null), "");
});

test("채점문: 번호+배점 형식의 항목 줄을 표로 바꾼다", () => {
  const md = [
    "## I. 병력청취 (History taking)",
    "1. 도입 (5점): X (자기소개 생략)",
    "2. ICE (6점): △ (기대 질문 없음)",
    "3. 진찰 전 설명·동의 (3점): O (설명함)",
    "",
    "잘한 점",
  ].join("\n");
  const out = tabulateEvaluation(md);
  assert.match(out, /^\| 항목 \| 평가 \| 점수 \| 근거 \|$/m);
  assert.match(out, /^\| 도입 \| X \| 0 \/ 5 \| 자기소개 생략 \|$/m);
  assert.match(out, /^\| ICE \| △ \| 3 \/ 6 \| 기대 질문 없음 \|$/m);
  assert.match(out, /^\| 진찰 전 설명·동의 \| O \| 3 \/ 3 \| 설명함 \|$/m);
  assert.match(out, /^## I\. 병력청취 \(History taking\)$/m); // 제목과 나머지 글은 그대로
  assert.match(out, /^잘한 점$/m);
});

test("채점문: 배점이 없는 형식은 채점표에서 배점을 찾고, 근거 안의 쌍점·괄호는 근거로 둔다", () => {
  const md = '1. 도입: O (자기소개, 성함/나이 확인)\n2. ICE: O (생각: "독감", 걱정: "일을 못 나감")\n3. 요약·확인: N (판단 불가)';
  const out = tabulateEvaluation(md);
  assert.match(out, /^\| 도입 \| O \| 5 \/ 5 \| 자기소개, 성함\/나이 확인 \|$/m);
  assert.match(out, /^\| ICE \| O \| 6 \/ 6 \| 생각: "독감", 걱정: "일을 못 나감" \|$/m);
  // 병력청취·PPI 의 N 은 △(절반)로 센다 — scoring.js 의 규칙과 같다
  assert.match(out, /^\| 요약·확인 \| 해당없음 \| 2 \/ 4 \| 판단 불가 \|$/m);
});

test("채점문: 진찰 항목의 N 은 만점, 모르는 항목은 점수 칸을 비운다", () => {
  const out = tabulateEvaluation("1. 핵심 진찰 수기 2: N (수기가 하나뿐)\n2. 엉뚱한 항목: O (그냥)");
  assert.match(out, /^\| 핵심 진찰 수기 2 \| 해당없음 \| 6 \/ 6 \|/m);
  assert.match(out, /^\| 엉뚱한 항목 \| O \| - \|/m);
});

test("채점문: 항목 줄이 하나뿐이거나 이미 표가 있는 글, 일반 문장은 그대로 둔다", () => {
  const single = "도입: O (좋음)\n\n본문";
  assert.equal(tabulateEvaluation(single), single);
  const table = "| 항목 | 점수 |\n| --- | --- |\n| 도입 | 5 |";
  assert.equal(tabulateEvaluation(table), table);
  const prose = "환자의 걱정: 일을 못 나갈까 봐 걱정함\n다음 줄";
  assert.equal(tabulateEvaluation(prose), prose);
  assert.equal(tabulateEvaluation(""), "");
});

test("채점문: 근거에 파이프가 있어도 표가 깨지지 않는다", () => {
  const out = tabulateEvaluation("1. 도입: O (A | B)\n2. 라포 형성: X (C)");
  const row = out.split("\n").find((l) => l.startsWith("| 도입"));
  assert.equal(row.split("|").length, 6); // 앞뒤 빈 칸 포함 4칸
  assert.match(row, /A ／ B/);
});

test("내보내기 .md: 전사는 평가 앞까지만, 채점은 표로", () => {
  const md = recordToMarkdown({
    topic: "발열",
    evaluationText: "1. 도입: O (좋음)\n2. 라포 형성: X (없음)",
    transcript: "의사: 안녕하세요\n\n환자: 네\n\n의사: 평가\n\n환자: 채점문",
  });
  assert.match(md, /\| 도입 \| O \| 5 \/ 5 \| 좋음 \|/);
  const script = md.split("## 문진 전사")[1];
  assert.match(script, /의사: 안녕하세요/);
  assert.ok(!script.includes("채점문") && !script.includes("의사: 평가"));
});

import { parseEvalItems, stripEvalItems, findReason } from "../docs/export.js";

const NARRATIVE = [
  "## I. 병력청취 (History taking)",
  "1. 도입 (5점): O (자기소개, 성함/나이 확인)",
  "2. ICE: △ (기대 질문 없음)",
  "## II. 신체진찰 (Physical exam)",
  "1. 핵심 진찰 수기 1: O (인후 시진)",
  "2. 핵심 진찰 수기 2: O (폐 청진)",
  "",
  "잘한 점",
  "- 자기소개를 했다",
  "",
  "개선점",
  "- \"안전망\"을 안내하세요",
  "",
  "대화 확인으로 조정한 항목",
  "- ICE: O → △ (기대 질문 없음)",
].join("\n");

test("채점문에서 항목 근거를 뽑는다", () => {
  const items = parseEvalItems(NARRATIVE);
  assert.deepEqual(items.map((i) => [i.label, i.mark]), [["도입", "O"], ["ICE", "△"], ["핵심 진찰 수기 1", "O"], ["핵심 진찰 수기 2", "O"]]);
  assert.equal(items[0].comment, "자기소개, 성함/나이 확인");
  // 조정 항목 줄("- ICE: O → △ (…)")은 항목으로 세지 않는다
  assert.equal(items.length, 4);
});

test("항목 줄과 구역 제목을 걷고 잘한 점·개선점·조정 항목은 남긴다", () => {
  const out = stripEvalItems(NARRATIVE);
  assert.ok(!/도입|핵심 진찰 수기|History taking|Physical exam/.test(out));
  assert.match(out, /^잘한 점$/m);
  assert.match(out, /^개선점$/m);
  assert.match(out, /대화 확인으로 조정한 항목/);
  assert.match(out, /ICE: O → △/); // 조정 내역은 그대로
  assert.ok(!/\n{3,}/.test(out));
});

test("항목 줄이 하나뿐이면 걷지 않는다", () => {
  const one = "도입: O (좋음)\n\n본문";
  assert.equal(stripEvalItems(one), one);
});

test("점수 표 항목 이름에 맞는 근거를 찾는다 (짧은 이름·긴 이름, 수기 1/2 합치기)", () => {
  const items = parseEvalItems(NARRATIVE);
  assert.equal(findReason(items, "ICE (환자의 생각·걱정·기대)"), "기대 질문 없음");
  assert.equal(findReason(items, "도입"), "자기소개, 성함/나이 확인");
  assert.equal(findReason(items, "핵심 진찰 수기 1"), "인후 시진");
  assert.equal(findReason(items, "핵심 진찰 수기"), "인후 시진 / 폐 청진"); // 수기가 하나로 합쳐진 케이스
  assert.equal(findReason(items, "없는 항목"), "");
});
