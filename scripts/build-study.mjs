// 공부 탭 자료 만들기 — cpx-worker 의 카드(src/cases)와 주제별 채점표(refs/checklists)에서
// docs/study/index.json 과 docs/study/<카드>.json 을 만든다. 면담 서버를 거치지 않는 정적 파일이다.
//
//   node scripts/build-study.mjs            (cpx-tracker 폴더에서)
//
// 카드를 고치면 다시 돌려 docs/study 를 갱신한 뒤 배포한다. 같은 입력이면 같은 출력이 나온다(무작위 없음).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// 카드와 채점표는 cpx-worker 저장소에 있다 (예전에는 cpx-plugin).
const WORKER = join(here, "..", "..", "cpx-worker");
const CASES = join(WORKER, "src", "cases");
const REFS = join(WORKER, "refs");
const OUT = join(here, "..", "docs", "study");
// 사람이 쓴 면담 가이드(질문 흐름·감별 비교표). 카드에서 자동으로 못 만드는 부분이라 따로 둔다. 있는 주제만 붙는다.
const GUIDES = join(here, "..", "study-guides");

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const index = read(join(CASES, "index.json"));

// ---------------------------------------------------------------- 문장 손질

// 인물 카드에서 채워지는 슬롯 (sampleCase.js 의 auto 와 같은 이름). 공부 자료에는 특정 인물이 없으므로
// 성별에 따라 갈리는 말은 둘 다, 음주·흡연은 시나리오 제약이 말해 주는 만큼만 적는다.
const ALCOHOL = { heavy: "술을 많이 마셔요.", drinker: "술을 마셔요.", notHeavy: "술은 많이 마시지 않아요.", never: "술은 안 마셔요." };
const SMOKING = { heavy: "담배를 오래 많이 피웠어요.", current: "담배를 피워요.", notCurrent: "지금은 담배를 안 피워요.", never: "담배는 안 피워요." };
function personaSlots(c) {
  return {
    olderBro: "형(오빠)",
    olderSis: "누나(언니)",
    spouse: "남편(아내)",
    inlaws: "처가(시댁)",
    alcoholSay: ALCOHOL[c?.alcohol] || "(음주량은 환자마다 다름)",
    alcoholSayHon: ALCOHOL[c?.alcohol] || "(음주량은 환자마다 다름)",
    smokingSay: SMOKING[c?.smoking] || "(흡연력은 환자마다 다름)",
  };
}

// 슬롯은 면담마다 다르게 뽑힌다. 예전에는 첫 번째 변주로 채워 "12시간 전"처럼 한 값이 확정인 듯 보였다(2026-11-23).
// 숫자 변주는 범위("12~24"), 짧은 말 변주는 "A / B", 긴 문장 변주는 첫 예시 뒤에 "(환자마다 다름)"을 붙인다.
// 변주 값 안에 다시 인물 슬롯이 들어 있는 경우가 있어(예: deceased → "{{spouse}}") 남은 것이 없을 때까지 몇 번 채운다.
function fill(text, vars) {
  let t = String(text ?? "");
  for (let i = 0; i < 3 && /\{\{\w+\}\}/.test(t); i++) t = fillOnce(t, vars);
  return t;
}
function slotText(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) return String(v.text ?? v.label ?? "…");
  return String(v);
}
function fillOnce(text, vars) {
  return String(text ?? "").replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars?.[k];
    if (v == null) return "(환자마다 다름)";
    if (!Array.isArray(v)) return slotText(v);
    const vals = [...new Set(v.map(slotText))];
    if (vals.length === 1) return vals[0];
    const nums = vals.map(Number);
    if (nums.every((n) => Number.isFinite(n))) return `${Math.min(...nums)}~${Math.max(...nums)}`;
    if (vals.every((x) => x.length <= 12 && !/\{\{/.test(x))) return vals.join(" / ");
    return `${vals[0]} (환자마다 다름)`;
  });
}

// 카드 작성자가 모델에게 남긴 지시문은 학생이 읽을 글이 아니다.
const DIRECTIVE = /인물 카드|덮어쓴다|변주|반드시|필수|모델|프롬프트|슬롯|그대로 쓴다|로 읽는다|맞춘다|채운다/;
function clean(text) {
  return String(text ?? "")
    .split(/(?<=[.。])\s+/)
    .filter((s) => s.trim() && !DIRECTIVE.test(s))
    .join(" ")
    .replace(/\s*\([^()]*(?:맞춘다|뽑은|슬롯|채운다|작성자|모델이)[^()]*\)/g, "")
    .trim();
}

const EMPTY = /^(없음|없다|해당 없음|특이 병력 없음|특이사항 없음|특이 사항 없음|특별히 없음|-|…)\.?$/;
const nonEmpty = (s) => s && !EMPTY.test(s.trim());

// 진찰 소견 가운데 "이상이 있는 것"만 단서로 뽑는다. 정상·음성 소견은 감별에 덜 중요하고 양이 많다.
const NORMAL = /^(정상|특이\s*소견\s*없|없음|없다|음성|만져지지 않는다|들리지 않는다)|(?:정상|없음|없다|없고|음성|특이소견 없음)\.?$/;
const SKIP_FINDING = /동의|설명|전신 외관|신체계측/;
// 확률 소견({p, detected, notDetected})은 환자에 따라 있을 수도 없을 수도 있다 — 있을 때 소견 뒤에 ± 를 붙인다.
function findingText(v) {
  if (v && typeof v === "object") return v.detected != null ? `${v.detected} ±` : v.text ?? "";
  return v;
}

// 활력징후는 카드에 범위로 있고 면담마다 그 안에서 뽑힌다 — 가운데값 하나("약 109회/분") 대신 범위를 보여 준다.
function vitalClues(v) {
  if (!v) return [];
  const mid = (r) => (Array.isArray(r) ? (Number(r[0]) + Number(r[1])) / 2 : Number(r));
  const span = (r, d = 0) => {
    const f = (n) => (d ? Math.round(Number(n) * 10) / 10 : Math.round(Number(n)));
    return Array.isArray(r) && Number(r[0]) !== Number(r[1]) ? `${f(r[0])}~${f(r[1])}` : `${f(Array.isArray(r) ? r[0] : r)}`;
  };
  // 범위 전체가 기준을 넘으면 "빈맥", 일부만 넘으면(정상에 걸치면) "빈맥 가능"으로 쓴다.
  const lo = (r) => Number(Array.isArray(r) ? Math.min(...r.map(Number)) : r);
  const hi = (r) => Number(Array.isArray(r) ? Math.max(...r.map(Number)) : r);
  const out = [];
  const add = (name, all, text) => out.push(`${name}${all ? "" : " 가능"} (${text})`);
  const t = mid(v.temp), sbp = mid(v.sbp), hr = mid(v.hr), rr = mid(v.rr), spo2 = mid(v.spo2);
  if (t >= 37.8) add("발열", lo(v.temp) >= 37.8, `체온 ${span(v.temp, 1)}℃`);
  if (sbp && sbp < 100) add("저혈압", hi(v.sbp) < 100, `수축기 ${span(v.sbp)} mmHg`);
  if (sbp >= 150) add("혈압 상승", lo(v.sbp) >= 140, `수축기 ${span(v.sbp)} mmHg`);
  if (hr > 100) add("빈맥", lo(v.hr) > 100, `맥박 ${span(v.hr)}회/분`);
  if (hr && hr < 55) add("서맥", hi(v.hr) < 60, `맥박 ${span(v.hr)}회/분`);
  if (rr > 22) add("빈호흡", lo(v.rr) > 20, `호흡 ${span(v.rr)}회/분`);
  if (spo2 && spo2 < 94) add("산소포화도 저하", hi(v.spo2) < 95, `${span(v.spo2)}%`);
  return out;
}

function who(c) {
  const [lo, hi] = c?.ageRange || [];
  const sex = c?.sex === "male" ? "남성" : c?.sex === "female" ? "여성" : "남녀";
  if (lo == null) return sex;
  return lo === hi ? `${lo}세 ${sex}` : `${lo}~${hi}세 ${sex}`;
}

const HPI_LABEL = { onset: "발병", character: "양상", location: "위치", radiation: "방사", aggravating: "악화 요인", relieving: "완화 요인", course: "경과", timing: "시간 양상" };

function scenarioClues(s) {
  const vars = { ...personaSlots(s.constraints), ...(s.variations || {}) };
  const f = (x) => clean(fill(x, vars));
  const hpi = [];
  for (const [k, label] of Object.entries(HPI_LABEL)) {
    const t = f(s.hpi?.[k]);
    if (nonEmpty(t)) hpi.push({ label, text: t });
  }
  const pos = (s.assoc?.positive || []).map(f).filter(nonEmpty);
  const neg = (s.assoc?.negative || []).map(f).filter(nonEmpty).slice(0, 6);
  const history = [];
  const pmh = f(s.pmh), meds = f(s.meds), fh = f(s.fh);
  if (nonEmpty(pmh)) history.push({ label: "과거력", text: pmh });
  if (nonEmpty(meds)) history.push({ label: "약", text: meds });
  if (nonEmpty(fh)) history.push({ label: "가족력", text: fh });
  const risk = (s.constraints?.requiredRisk || []).filter(Boolean);
  if (risk.length) history.push({ label: "위험인자", text: risk.join(", ") });
  const pe = [];
  for (const [k, v] of Object.entries(s.pe?.findings || {})) {
    if (SKIP_FINDING.test(k)) continue;
    const t = f(findingText(v));
    if (!t || NORMAL.test(t.trim())) continue;
    pe.push({ label: k, text: t });
  }
  // 놓치면 안 되는 질문 — 답이 "있다" 쪽인 Red flag (없다·아니다로 시작하는 답은 뺀다)
  const flags = [];
  for (const [q, a] of Object.entries(s.redFlags || {})) {
    const ans = f(a);
    if (!ans || /^(아뇨|아니|없|그런 (건|적)|안 |전혀)/.test(ans.trim())) continue;
    flags.push({ q: f(q), a: ans });
  }
  return {
    id: s.id,
    dx: f(s.dx || s.situation || s.id),
    who: who(s.constraints),
    opening: f(Array.isArray(s.opening) ? s.opening[0] : s.opening),
    hpi,
    positive: pos,
    negative: neg,
    flags: flags.slice(0, 8),
    history,
    vitals: vitalClues(s.pe?.vitals),
    pe: pe.slice(0, 8),
  };
}

// ---------------------------------------------------------------- 채점표를 학생용으로

// 채점표 원본은 채점에 그대로 쓰이므로 건드리지 않고, 공부 화면에 보일 사본만 손질한다.
// 채점자를 위한 설명(공통 배점표의 어느 칸을 대신하는지, SKILL.md 규칙 이름, 시나리오 ID)은 학생에게 뜻이 없다.
function studentChecklist(md, scenarios) {
  const names = Object.fromEntries(scenarios.map((s) => [s.id, s.dx]));
  let t = String(md || "").replace(/\r\n?/g, "\n");
  const start = t.search(/^## /m);
  if (start > 0) t = t.slice(start); // 맨 앞의 채점자용 안내문
  return t
    .replace(/^## 치명적 오류.*$/m, "## 이렇게 하면 점수와 관계없이 '미흡'")
    .replace(/^이번 시나리오에서 아래 중 하나라도[^\n]*\n/m, "")
    .replace(/^(\s*-\s*)치명:\s*/gm, "$1")
    .replace(/\s*—\s*판정은 SKILL\.md[^\n]*/g, "") // 채점 세부 규칙 안내
    .replace(/\s*—\s*topics\.md[^\n(]*/g, " ") // "— topics.md PE 초점 참고"
    .replace(/\s*\(topics\.md 기준\)/g, "")
    .replace(/\(케이스에 따라[^)\n]*배점\)/g, "")
    // 채점 방법을 설명하는 문단(목록·제목이 아닌 줄)에 내부 파일·신호어가 나오면 통째로 뺀다.
    .split("\n")
    .filter((line) => /^\s*(#|-|\||\d+\.)/.test(line) || !/SKILL\.md|topics\.md|checklist\.md|채점한다|신호/.test(line))
    .join("\n")
    .replace(/\s*\((?:I|II)-?\d*\s*대체[^)]*\)/g, "") // "(I-6 대체, 병력청취 소계에 합산)"
    .replace(/\s*—?\s*공통 I-\d+\s*의[^.\n]*칸을 대신한다\.?/g, "")
    .replace(/\(([a-z]{2,}-[a-z0-9-]+(?:,\s*[a-z]{2,}-[a-z0-9-]+)*)\)/g, (m, ids) =>
      "(" + ids.split(/,\s*/).map((id) => names[id] || id).join(", ") + ")")
    .replace(/\b([a-z]{2,}-[a-z0-9-]+)\b/g, (m) => names[m] || m)
    .replace(/^(\s*)- \[[ xX]\] /gm, "$1- ");
}

// ---------------------------------------------------------------- 만들기

mkdirSync(OUT, { recursive: true });
const list = [];
const topics = Object.entries(index.topics).sort((a, b) => a[1].file.localeCompare(b[1].file, "en", { numeric: true }));
for (const [name, t] of topics) {
  if (t._procedureCase || t._noPhysicalExam) continue; // 웹 면담이 다루지 않는 술기·나쁜 소식 전하기
  const data = read(join(CASES, t.file));
  const key = t.file.replace(/\.json$/, "");
  const mdPath = join(REFS, "checklists", key + ".md");
  // 주제 전용 채점표가 없으면(예방접종·상담 주제 등) 공통 채점표를 보여 준다. 실제 평가도 그 표로 한다.
  const own = existsSync(mdPath);
  const rawChecklist = readFileSync(own ? mdPath : join(REFS, "checklist.md"), "utf8");
  const scenarios = (data.scenarios || []).map(scenarioClues);
  const checklist = studentChecklist(rawChecklist, scenarios);
  const guidePath = join(GUIDES, key + ".json");
  const guide = existsSync(guidePath) ? read(guidePath) : null;
  if (guide) {
    // 가이드의 비교표 진단명이 카드와 어긋나면(카드를 고친 뒤 가이드를 안 고친 경우) 알린다.
    const dxs = new Set(scenarios.map((s) => s.dx));
    const stale = (guide.compare?.rows || []).filter((r) => !dxs.has(r.dx)).map((r) => r.dx);
    if (stale.length) console.log(`!! ${key}: 가이드 비교표의 진단이 카드에 없음 — ${stale.join(", ")}`);
  }
  writeFileSync(join(OUT, key + ".json"), JSON.stringify({ name, key, scenarios, checklist, commonChecklist: !own, guide }, null, 1));
  list.push({ name, key, count: scenarios.length, dx: scenarios.map((s) => s.dx), guide: !!guide });
}
writeFileSync(join(OUT, "index.json"), JSON.stringify({ topics: list }, null, 1));
console.log(`공부 자료 ${list.length}개 주제, 시나리오 ${list.reduce((a, b) => a + b.count, 0)}개 → ${OUT}`);
const leftover = readdirSync(OUT).filter((f) => f !== "index.json" && !list.some((x) => x.key + ".json" === f));
if (leftover.length) console.log("남은 옛 파일(지워도 됨):", leftover.join(", "));
