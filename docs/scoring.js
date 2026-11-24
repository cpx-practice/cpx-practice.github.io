// 웹 면담 채점 점수 계산.
//
// AI 가 직접 소계·총점을 적게 하면 틀린다 — Gemma 4 테스트에서 항목 합이 26점인데
// "47 / 60"으로 적고, 형식 예시에 있던 숫자(78·45)에 끌려간 총점이 그대로 기록에 저장됐다.
// 그래서 AI 는 항목별 O/△/X(해당없음은 N)만 cpx-record 의 marks 로 내고, 점수·소계·
// 총점·등급은 여기서 계산한다.
//
// 항목과 배점은 cpx-worker/src/interviewPrompt.js 의 CHECKLIST·MARK_KEYS 와 같아야 한다.

export const SECTIONS = [
  {
    key: "history",
    title: "I. 병력청취",
    items: [
      ["intro", "도입", 5],
      ["hpi", "주호소&현병력", 20],
      ["ice", "ICE (환자의 생각·걱정·기대)", 6],
      ["redflag", "Red Flag/감별진단", 10],
      ["pmh", "과거력·약물력·가족력·사회력", 12],
      ["safety", "Safety Netting", 7],
    ],
  },
  {
    key: "pe",
    title: "II. 신체진찰",
    items: [
      ["consent", "진찰 전 설명·동의", 3],
      ["vitals", "활력징후 확인", 5],
      ["pe1", "핵심 진찰 수기 1", 6],
      ["pe2", "핵심 진찰 수기 2", 6],
    ],
  },
  {
    key: "ppi",
    title: "III. PPI",
    items: [
      ["rapport", "라포 형성", 4],
      ["order", "질문 순서", 4],
      ["empathy", "경청·공감", 4],
      ["summary", "요약·확인", 4],
      ["language", "언어사용", 2],
      ["closing", "마무리 인사", 2],
    ],
  },
];

const RATIO = { O: 1, "△": 0.5, X: 0, N: 1 }; // N(해당없음)은 체크리스트 규칙대로 만점
// 해당없음이 성립하는 항목은 신체진찰뿐이다 (진찰이 없는 케이스, 핵심 수기가 1개뿐인 케이스).
// 병력청취·PPI 항목에 모델이 "판단 불가"의 뜻으로 N 을 붙여 공짜 만점이 되는 일이 있어서(언어사용 N → 2/2) △ 로 본다.
const NA_ALLOWED = new Set(["consent", "vitals", "pe1", "pe2"]);

function normMark(v) {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "O" || s === "○") return "O";
  if (s === "△" || s === "Δ" || s === "▲" || s === "TRIANGLE") return "△";
  if (s === "X") return "X";
  if (s === "N" || s === "N/A" || s === "-") return "N";
  return null;
}

/** 기록에 남길 항목별 표시 — 아는 항목 키와 O/△/X/N 만 (모델이 엉뚱한 값을 넣어도 저장되지 않게). */
export function cleanMarks(marks) {
  if (!marks || typeof marks !== "object") return null;
  const out = {};
  for (const sec of SECTIONS) for (const [k] of sec.items) {
    const m = normMark(marks[k]);
    if (m) out[k] = m;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 최근 기록에서 자주 깎이는 항목 — 홈 화면 추천용. rows 는 최신순, 항목 표시(marks)가 있는 기록만 센다.
 * 최근 n개 중 그 항목이 min 번 이상 채점됐고 평균 비율이 under 미만인 것을 낮은 순으로 돌려준다.
 * N(해당없음)은 세지 않는다. lastTopic 은 그 항목이 가장 최근에 깎인(O 가 아닌) 기록의 주제.
 */
export function weakItems(rows, { n = 10, min = 3, under = 0.7 } = {}) {
  const recent = (rows || []).filter((r) => r && r.marks && typeof r.marks === "object").slice(0, n);
  const out = [];
  for (const sec of SECTIONS) for (const [k, label] of sec.items) {
    let sum = 0;
    let cnt = 0;
    let lastTopic = null;
    for (const r of recent) {
      const m = normMark(r.marks[k]);
      if (!m || m === "N") continue;
      sum += RATIO[m];
      cnt++;
      if (m !== "O" && lastTopic === null) lastTopic = r.topic || null;
    }
    if (cnt >= min && sum / cnt < under) out.push({ key: k, label, ratio: sum / cnt, count: cnt, lastTopic });
  }
  return out.sort((a, b) => a.ratio - b.ratio);
}

/**
 * 같은 주제의 바로 앞 기록과 이번 채점을 견준다 — 채점 결과 창의 "지난번과 비교".
 * rows 는 최신순(이번 기록은 아직 저장 전이라 들어 있지 않다), sameTopic(r) 로 같은 주제인지 판단한다.
 * 앞 기록이 없으면 null. 항목 표시가 양쪽에 있으면 오른 항목·내린 항목 이름도 준다.
 */
export function compareWithPrevious(rows, sameTopic, record) {
  const prev = (rows || []).find((r) => r && typeof r.totalScore === "number" && sameTopic(r));
  if (!prev || typeof record?.total !== "number") return null;
  const out = { prevScore: prev.totalScore, delta: record.total - prev.totalScore, better: [], worse: [] };
  const a = prev.marks && typeof prev.marks === "object" ? prev.marks : null;
  const b = record.marks && typeof record.marks === "object" ? record.marks : null;
  if (a && b) {
    for (const sec of SECTIONS) for (const [k, label] of sec.items) {
      const x = normMark(a[k]);
      const y = normMark(b[k]);
      if (!x || !y || x === "N" || y === "N" || x === y) continue;
      (RATIO[y] > RATIO[x] ? out.better : out.worse).push({ label, from: x, to: y });
    }
  }
  return out;
}

export function gradeFromTotal(total) {
  if (total >= 90) return "우수";
  if (total >= 80) return "양호";
  if (total >= 70) return "보통 (개선 필요)";
  return "미흡";
}

/**
 * record.marks 가 있으면 점수를 계산해 {history, pe, ppi, total, grade, rows} 를 돌려준다.
 * 항목 표시가 빠지거나 이상하면 X 로 본다(점수를 부풀리지 않는 쪽).
 * marks 가 아예 없으면 null — 호출부는 AI 가 적은 숫자를 그대로 쓴다(예전 형식 호환).
 */
export function scoreRecord(record) {
  const marks = record && typeof record.marks === "object" && record.marks ? record.marks : null;
  if (!marks) return null;
  const result = { rows: [] };
  let total = 0;
  for (const sec of SECTIONS) {
    let items = sec.items;
    // 핵심 수기가 1개뿐인 케이스(pe2 가 N)는 12점을 수기 1에 몰아준다 (체크리스트 규칙).
    if (sec.key === "pe" && normMark(marks.pe2) === "N") {
      items = items.filter(([k]) => k !== "pe2").map((it) => (it[0] === "pe1" ? ["pe1", "핵심 진찰 수기", 12] : it));
    }
    let sub = 0;
    let max = 0;
    for (const [k, label, pts] of items) {
      let m = normMark(marks[k]) || "X";
      if (m === "N" && !NA_ALLOWED.has(k)) m = "△";
      const got = pts * RATIO[m];
      sub += got;
      max += pts;
      result.rows.push({ section: sec.title, label, mark: m, got, pts });
    }
    sub = Math.round(sub);
    result[sec.key] = sub;
    result.rows.push({ section: sec.title, subtotal: true, got: sub, pts: max });
    total += sub;
  }
  result.total = total;
  // 치명적 오류가 있으면 점수는 그대로 두고 등급만 미흡으로 고정한다 (플러그인 채점 규칙과 같음).
  result.grade = record.fatal ? "미흡" : gradeFromTotal(total);
  return result;
}

// ---------------------------------------------------------------- 대화로 확인하는 항목
//
// 무료 모델(Gemma 4)은 "판정 전에 발화를 찾아라"는 지시를 따르지 않고, 하지 않은 자기소개를
// "자기소개 및 환자 확인 수행"이라고 지어내 O 를 줬다. 대화에서 기계적으로 확인할 수 있는
// 항목은 여기서 학생 발화를 직접 보고, 근거가 없으면 표시를 낮춘다. 올리지는 않는다 —
// 표현이 정규식에 안 걸린 정상 수행을 깎는 쪽보다, 안 한 것에 점수를 주는 쪽이 더 나빠서다.

const CUE = /^\s*(진찰|평가)\s*$/;
const PAREN_EXAM = /\([^)]*(촉진|청진|타진|시진|혈압|진찰|눌러|두드려|두드리|들어보|재보|측정)[^)]*\)/;
const CHECKS = {
  selfIntro: /(저는|제\s*이름은|담당|의사|학생|인턴|실습|레지던트|전공의).{0,20}(입니다|이에요|예요|라고\s*합니다)/,
  idCheck: /(성함|이름|나이|연세|생년월일|관계|본인|환자분\s*(맞|이시|되시)|맞으시(죠|나요|지요))/,
  // 열린 질문으로 문진을 시작했는가 — "어디가 불편해서 오셨어요?", "어떻게 오셨어요?", "오늘 무슨 일로 오셨어요?"
  openQ: /(어디가|어디\s*가)\s*(불편|아프)|어떻게\s*오셨|무슨\s*일로\s*오셨|어떤\s*(일|문제|증상|이유)로\s*오셨|불편하신\s*(게|점|곳|데)|오늘\s*(어떻게|무슨|어떤)/,
  iceIdea: /(원인|생각하세요|생각하시|생각이\s*(드|있)|짚이는|때문인\s*것\s*같|뭐\s*때문|왜\s*그런|이유가\s*(있|짐작)|짐작)/,
  iceConcern: /(걱정|불안|염려|우려|두려)/,
  iceExpect: /(바라|원하시|원하세요|기대|도움을\s*받|어떤\s*도움|해\s*드렸으면)/,
  summary: /(정리하면|정리해\s*보면|정리해\s*드리|요약하면|요약해\s*보면|말씀하신\s*(내용|걸|것)|이해한\s*(게|것|대로)|다시\s*(한\s*번\s*)?말씀드리면|맞나요|맞으세요|맞으신가요|맞으시죠|맞습니까)/,
  closing: /(건강하세요|쾌유|빨리\s*나으|살펴\s*가|수고하셨|수고\s*많으셨|고생\s*많으셨|고생하셨|안녕히|조심히|들어가세요|다음에\s*뵙|다시\s*뵙|감사합니다|고맙습니다)/,
  consent: /(괜찮으|해도\s*될까|해도\s*되|봐도\s*되|하겠습니다|보겠습니다|드리겠습니다|볼게요|할게요|진찰을\s*위해|양해|누워\s*주)/,
  // 진찰 전 설명·동의는 "무엇을 할지 구체적으로 설명"하고 "허락을 구하거나 불편하면 알려 달라고 안내"해야 만점이다.
  // "진찰을 시작하겠습니다" 같은 통보만으로는 △ 까지만 준다.
  consentSpecific: /(혈압|체온|맥박|청진|촉진|타진|시진|목구멍|입을\s*벌|인두|복부|배를|배\s*좀|가슴|심장|폐|숨\s*소리|눌러|두드려|들어\s*보|살펴|누워)/,
  consentPermit: /(괜찮으|해도\s*될까|해도\s*되|봐도\s*되|동의|양해|허락|불편하(시)?면|아프(시)?면|말씀해\s*주)/,
  safety: /(심해지|악화|지켜보시다가|경과를\s*보|다시\s*오|재방문|내원|응급실|연락|면\s*(바로|곧바로|즉시)|(면|때|경우).{0,15}(알려|말씀해)\s*주세요|생기면|나타나면)/,
  // 과거력·약물력·가족력·사회력 — 이 중 하나도 묻지 않았는데 O 를 주는 것을 막는 최소 확인.
  pmh: /(과거|병력|앓|질환|지병|약s*(은|을|이|도|s)|복용|드시는s*약|가족|집안|술|음주|담배|흡연|직업|하시는s*일|수술|입원|알레르기|알러지)/,
  // 진찰 동작 — "진찰" 신호 뒤에 학생이 한 진찰 말. 신호어만 있고 동작이 없으면 핵심 수기는 수행되지 않은 것이다.
  examAct: /(촉진|청진|타진|시진|눌러|두드려|두드리|들어s*(보|볼)|살펴|살펴보|재s*(보|볼|겠)|측정|관찰|반사|만져|짚어|펴s*(보|볼)|벌려|혈압|체온|맥박|동공|갑상선|림프|복부|배를|가슴|폐|심장|목을|눈을|귀를|인후|근력|감각|관절|피부|다리|팔을|등을|허리)/,
  weight: /(체중|몸무게|살이\s*빠|살\s*빠|살이\s*줄|마르셨|말랐|야위)/,
};
const ORDER = { X: 0, "△": 1, O: 2 };
// 상담·심리사회 케이스는 Red Flag 가 자살 위험·안전 평가 같은 케이스 고유 항목이라 전신증상 질문을 요구하지 않는다.
const NO_SYSTEMIC_TOPICS = new Set([
  "가정폭력", "성폭력", "자살", "물질오남용", "음주 상담", "금연 상담", "예방접종", "산전 진찰",
  "성장 지연", "발달 지연", "나쁜 소식 전하기",
]);

// 케이스 고유 위험 신호 질문 — 카드의 Red flag 질문(공부 자료 scenarios[].flags[].q)에서 핵심 낱말을 뽑아,
// 학생이 그중 하나라도 물었는지 본다. 모든 주제에서 묻는 일반 문진(OPQRST·과거력·전신증상)에 들어 있는 낱말은 뺀다 —
// 그 질문만으로 위험 신호를 물었다고 볼 수 없어서다 (2026-11-23 Gemma 가 천식 악화 환자에게 일반 문진만 한 면담을
// Red Flag O·100점으로 채점했다. 말을 이어 할 수 있는지·가만히 있어도 숨찬지 같은 질문은 하나도 없었다).
const GENERIC_QS = [
  "언제부터 그러셨어요?", "어떤 느낌으로 아프세요?", "정확히 어디가 제일 불편하세요?", "다른 곳으로 퍼지지는 않나요?",
  "어떻게 하면 더 심해지세요?", "어떻게 하면 좀 나아지세요?", "10점 만점이면 몇 점 정도로 불편하세요?", "처음보다 점점 심해지고 있나요?",
  "예전에도 이런 적이 있으셨어요?", "같이 나타나는 다른 증상은 없으세요?", "혹시 짚이는 원인이 있으세요?", "열은 나세요?",
  "최근에 체중이 줄었나요?", "밤에 땀을 흘리시나요?", "예전에 앓으셨던 병이 있으세요?", "수술받거나 입원하신 적 있으세요?",
  "지금 드시는 약 있으세요?", "약 알레르기 있으세요?", "가족 중에 앓고 계신 병 있으세요?", "술은 얼마나 드세요?", "담배는 피우세요?",
  "하시는 일이 뭐예요?", "가장 걱정되시는 게 뭐예요?", "오늘 어떤 도움을 받고 싶으세요?", "얼마나 자주 그러세요?", "한 번 그러면 얼마나 가요?",
  // 저장된 기록 127건에 돌려 보니 아래 말이 위험 신호 질문으로 잘못 잡혔다 (진찰 동의의 "괜찮을까요", "전에도", "때문" 등).
  "진찰해도 괜찮을까요?", "그 전에는 괜찮으셨어요?", "왜 그런 것 같으세요? 무엇 때문인 것 같아요?", "어떻게 생각하세요?",
  "같은 증상이 또 있었나요?", "아픈 곳이 어디예요? 통증은 어떠세요?", "지금은 어느 정도예요?",
];
const TAIL = /(이나|에서|으로|하거나|거나|하나|한가|찬가|하게|하면|으면|는지|은지|인지|는|은|이|가|을|를|에|도|나|요|고|면|게|의|와|과)$/;
function stemsOf(text) {
  const out = new Set();
  for (const w of String(text || "").replace(/\([^)]*\)/g, " ").split(/[^가-힣]+/)) {
    const t = w.replace(TAIL, "");
    if (t.length >= 2) out.add(t.slice(0, 2));
  }
  return out;
}
const GENERIC_STEMS = new Set(GENERIC_QS.flatMap((q) => [...stemsOf(q)]));

/** 카드 Red flag 질문들 중 학생이 물은 것의 수. 학생 말에서 따옴표로 옮긴 환자 말("…")은 뺀다. */
export function redFlagHits(flagQs, studentTurns) {
  const said = studentTurns.map((t) => String(t).replace(/["“”'‘’][^"“”'‘’]*["“”'‘’]/g, " ")).join(" ");
  let hits = 0;
  for (const q of new Set(flagQs || [])) {
    const stems = [...stemsOf(q)].filter((x) => !GENERIC_STEMS.has(x));
    if (stems.some((x) => said.includes(x))) hits++;
  }
  return hits;
}

/**
 * history: [{role:"user"|"assistant", text}] — 평가 직전까지의 대화.
 * opts.redFlagQs: 이 주제 카드들의 Red flag 질문 목록 (없으면 이 확인은 건너뛴다).
 * record.marks 를 제자리에서 낮추고, 바꾼 내역 [{label, from, to, reason}] 을 돌려준다.
 */
export function auditMarks(record, history, opts = {}) {
  const marks = record && record.marks;
  if (!marks || !Array.isArray(history)) return [];
  const turns = history.filter((h) => h.role === "user").map((h) => String(h.text || ""));
  const said = turns.filter((t) => !CUE.test(t)).map((t) => t.replace(/\([^)]*\)/g, " "));
  const peStart = turns.findIndex((t) => /^\s*진찰\s*$/.test(t) || PAREN_EXAM.test(t));
  const any = (re, list = said) => list.some((t) => re.test(t));
  const changes = [];
  // 같은 항목을 두 번 고치면(예: 도입 O→△ 뒤 △→X) 한 줄로 합친다 — "O → X (마지막 이유)".
  const record_ = (key, from, to, reason) => {
    const label = SECTIONS.flatMap((s) => s.items).find(([k]) => k === key)?.[1] || key;
    const prev = changes.find((c) => c.key === key);
    if (!prev) return changes.push({ key, label, from, to, reason });
    if (prev.from === to) changes.splice(changes.indexOf(prev), 1);
    else Object.assign(prev, { to, reason });
  };
  const cap = (key, to, reason) => {
    const from = normMark(marks[key]);
    if (!from || from === "N" || ORDER[from] <= ORDER[to]) return;
    marks[key] = to;
    record_(key, from, to, reason);
  };
  // 낮추기만 하는 cap 과 반대로, 대화에서 확실히 확인된 항목을 그 아래로 매긴 경우만 올린다 (지금은 도입만).
  const floor = (key, to, reason) => {
    const from = normMark(marks[key]);
    if (!from || from === "N" || ORDER[from] >= ORDER[to]) return;
    marks[key] = to;
    record_(key, from, to, reason);
  };

  const early = said.slice(0, 4);
  const intro = [any(CHECKS.selfIntro, early), any(CHECKS.idCheck, said.slice(0, 6))];
  if (!intro[0] || !intro[1]) {
    cap("intro", "△", [!intro[0] && "자기소개", !intro[1] && "환자 확인(성함·나이)"].filter(Boolean).join("·") + " 발화 없음");
  }
  // 도입은 대화에서 확실히 가려낼 수 있다 — 모델이 한 것을 안 했다고 낮춘 경우는 올린다
  // (2026-11-22 Gemini 채점이 "저는 의사 김민수입니다"·"어디가 불편해서 오셨어요?"를 하고도 자기소개·개방형 질문 누락으로 X 를 줬다).
  const openQ = any(CHECKS.openQ, early);
  const introDone = [intro[0], intro[1], openQ].filter(Boolean).length;
  // 자기소개도 환자 확인도 없으면 도입은 X 다 (2026-11-23 "안녕하세요."만 하고도 "자기소개 확인됨"으로 △가 나왔다).
  if (!intro[0] && !intro[1]) cap("intro", "X", "자기소개·환자 확인 발화 없음");
  if (introDone === 3) floor("intro", "O", "자기소개·환자 확인·개방형 질문 모두 대화에 있음");
  else if (introDone === 2) floor("intro", "△", [intro[0] && "자기소개", intro[1] && "환자 확인", openQ && "개방형 질문"].filter(Boolean).join("·") + " 대화에 있음");

  // 현병력 — 진찰 전 문진 질문이 거의 없으면 낮춘다 ("언제부터요?" 하나에 20/20 이 나왔다).
  // 하위 요소를 표현으로 맞추는 방식은 주제마다 질문 모양이 달라(월경력·"누우면 더 힘드세요?" 등) 충실한 면담까지 깎았다 —
  // 기존 기록 121건에 적용해 보니 95건이 낮아졌다(2026-11-23). 그래서 질문 수로만, 사실상 빈 문진만 잡는다.
  const historyQs = (peStart >= 0 ? turns.slice(0, peStart) : turns)
    .filter((t) => !CUE.test(t))
    .filter((t) => /\?|요\s*$|까\s*$|세요|나요|어요|에요/.test(t.trim()))
    .filter((t) => !/^(안녕하세요|안녕하십니까)[.!,\s]*$/.test(t.trim()));
  if (historyQs.length <= 3) cap("hpi", "X", `진찰 전 문진 질문이 ${historyQs.length}개뿐`);
  else if (historyQs.length <= 5) cap("hpi", "△", `진찰 전 문진 질문이 ${historyQs.length}개`);

  const ice = [["생각(원인)", CHECKS.iceIdea], ["걱정", CHECKS.iceConcern], ["기대", CHECKS.iceExpect]];
  const missingIce = ice.filter(([, re]) => !any(re)).map(([n]) => n);
  if (missingIce.length === 3) cap("ice", "X", "생각·걱정·기대를 묻는 질문 없음");
  else if (missingIce.length) cap("ice", "△", `${missingIce.join("·")} 질문 없음`);

  // 전신증상(체중감소·발열·야간발한) 중 체중은 거의 모든 케이스에서 물어야 하는데 모델이 묻지 않아도 O 를 줬다.
  if (!NO_SYSTEMIC_TOPICS.has(String(record.topic || "").trim()) && !any(CHECKS.weight)) {
    cap("redflag", "△", "전신증상 중 체중 변화 질문 없음");
  }
  if (Array.isArray(opts.redFlagQs) && opts.redFlagQs.length) {
    const before = peStart >= 0 ? turns.slice(0, peStart) : turns;
    if (!redFlagHits(opts.redFlagQs, before)) cap("redflag", "△", "이 주제의 위험 신호 질문(일반 문진 외) 없음");
  }
  if (!any(CHECKS.summary)) cap("summary", "X", "환자 말을 정리해 확인하는 발화 없음");
  // 진찰 중의 "아프면 말씀해 주세요"는 안전망 안내가 아니다 — 진찰 신호부터 마지막 진찰 동작까지는 뺀다.
  let lastAct = -1;
  turns.forEach((t, i) => { if (PAREN_EXAM.test(t)) lastAct = i; });
  const safetyTurns = turns
    .filter((t, i) => !CUE.test(t) && !(peStart >= 0 && i >= peStart && i <= lastAct))
    .map((t) => t.replace(/\([^)]*\)/g, " "));
  if (!any(CHECKS.safety, safetyTurns)) cap("safety", "X", "악화 시 대처·재방문 안내 발화 없음");
  if (!any(CHECKS.closing, said.slice(-3))) cap("closing", "X", "끝인사 없음");

  // 과거력·약물력·가족력·사회력을 하나도 묻지 않았다면 O 일 수 없다.
  if (!any(CHECKS.pmh)) cap("pmh", "X", "과거력·약물력·가족력·사회력 질문 없음");

  // 진찰 동작 — 신호어("진찰")만 있고 동작을 말하지 않았으면 핵심 수기는 X (평가 프롬프트의 규칙과 같다).
  if (peStart < 0) {
    for (const k of ["vitals", "pe1", "pe2", "consent"]) cap(k, "X", "진찰을 하지 않음");
  } else {
    const acts = turns.filter((t, i) => i > peStart && !CUE.test(t)).map((t) => t.replace(/([^)]*)/g, " ") + " " + t);
    if (!acts.some((t) => CHECKS.examAct.test(t) || PAREN_EXAM.test(t))) {
      for (const k of ["pe1", "pe2"]) cap(k, "X", "진찰 신호 뒤에 진찰 동작 발화 없음");
    }
  }

  if (peStart >= 0) {
    // 진찰 신호 직전 말부터 첫 진찰 동작까지에서 설명·동의를 찾는다 — 진찰이 끝난 뒤의
    // "피검사 해볼게요" 같은 말은 진찰 전 동의가 아니다.
    let firstAct = turns.findIndex((t, i) => i >= peStart && PAREN_EXAM.test(t));
    if (firstAct < 0) firstAct = turns.findIndex((t, i) => i > peStart && !CUE.test(t));
    const end = firstAct < 0 ? turns.length : firstAct + 1;
    const around = turns.slice(Math.max(0, peStart - 1), end).filter((t) => !CUE.test(t)).map((t) => t.replace(/\([^)]*\)/g, " "));
    if (!any(CHECKS.consent, around)) cap("consent", "X", "진찰 전 설명·동의 발화 없음");
    else if (!(any(CHECKS.consentSpecific, around) && any(CHECKS.consentPermit, around))) {
      cap("consent", "△", any(CHECKS.consentSpecific, around) ? "허락을 구하거나 불편하면 알려 달라는 안내 없음" : "무엇을 진찰할지 구체적인 설명 없음");
    }
  }
  return changes;
}

/**
 * auditMarks 가 표시를 낮췄거나, ICE 를 대화로 다시 확인했을 때, AI 가 쓴 항목별 설명 줄이 점수와 어긋나지 않게 맞춘다.
 *   - 낮춘 항목의 줄 맨 앞 O/△/X 를 새 표시로 바꾼다 ("도입: O (…)" → "도입: △ (…)").
 *   - 생각·걱정·기대를 모두 물었고 표시도 O 인데 설명이 "질문은 없었"이라고 하면(모델이 자기 점수와 모순되게 쓴 경우)
 *     확인된 사실로 바꾼다.
 * 점수 자체는 바꾸지 않는다. shown(채점 본문)을 고쳐 돌려준다.
 */
/**
 * 서술문 속 "총점: 85점 (양호)" 줄을 코드가 계산한 점수로 맞춘다. 점수는 코드가 정답이고 AI 가 적은 숫자는 믿지 않는다 —
 * 표 위쪽은 "우수 90 / 100"인데 아래 문장은 AI 가 쓴 "85점 (양호)"로 남아 두 숫자가 엇갈린 적이 있다(2026-11-05, 월경이상).
 * 그 줄이 없으면 그대로 돌려준다.
 */
export function reconcileTotal(shown, scored) {
  if (!scored || typeof scored.total !== "number" || !scored.grade) return String(shown || "");
  // 공백은 같은 줄 안(스페이스·탭)만 — \s 를 쓰면 줄바꿈까지 먹어 앞의 빈 줄이 사라진다.
  // "총점: 85점 (양호)", "총점 85/100", 숫자 없이 "총점: 우수" 만 적힌 줄까지. 콜론이나 숫자가 바로 붙은 줄만 — "총점을 높이려면…" 같은 문장은 건드리지 않는다.
  // "총점/등급: 70 미만 미흡"처럼 지시문 문구를 그대로 옮긴 줄도 바꾼다 (2026-11-23 Gemma 채점).
  const re = /^([ \t>]*(?:[-*•][ \t]+|\d+[.)][ \t]+)?)(?:\*\*)?[ \t]*총점(?:[ \t]*\/[ \t]*등급)?[ \t]*(?:[:：][^\n]*|\d[^\n]*)$/m;
  return String(shown || "").replace(re, (_m, lead) => `${lead}총점: ${scored.total}점 (${scored.grade})`);
}

export function reconcileNarrative(shown, record, history, changes = []) {
  let text = String(shown || "");
  // 모델이 줄 앞에 목록 기호(-, *, •, 번호)나 굵은 글씨(**)를 붙이는 일이 있다. 화면에선 마크다운이라 안 보인다.
  const LEAD = "[ \\t>]*(?:[-*•]\\s+|\\d+[.)]\\s+)?(?:\\*\\*)?\\s*";
  const TAIL = "(?:\\*\\*)?";
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const c of changes) {
    const name = String(c.label).split(" (")[0];
    text = text.replace(new RegExp(`^(${LEAD}${esc(name)}${TAIL}\\s*[:：]\\s*(?:\\*\\*)?\\s*)(O|△|X|N)`, "m"), `$1${c.to}`);
  }
  // 대화 확인으로 판정을 올린 항목은, 그 항목을 "안 했다·해야 한다"고 쓴 개선점 줄도 뺀다 — 판정은 O 로 바로잡혔는데
  // 개선점에 "도입부에서 자기소개와 환자 확인을 정확히 시행해야 합니다"가 남아 있었다 (2026-11-23).
  const RAISED_TOPIC = { intro: /자기소개|환자\s*확인|본인\s*확인|신분|성함/ };
  const raisedKeys = changes.filter((c) => c.key && RAISED_TOPIC[c.key] && ORDER[c.to] > ORDER[c.from]).map((c) => c.key);
  if (raisedKeys.length) {
    const at = text.search(/^[ \t>#*]*(?:\*\*)?\s*개선점/m);
    if (at >= 0) {
      const head = text.slice(0, at);
      const tail = text.slice(at).split("\n");
      // 첫 줄(개선점 제목)은 두고, 그 아래 목록·문장 가운데 올린 항목을 다룬 줄만 뺀다. 다음 제목(대화 확인으로 조정…)에서 멈춘다.
      let stop = tail.findIndex((l, i) => i > 0 && /^[ \t>#*]*(?:\*\*)?\s*(대화 확인으로 조정|잘한 점|복습)/.test(l));
      if (stop < 0) stop = tail.length;
      const kept = tail.filter((l, i) => i === 0 || i >= stop || !raisedKeys.some((k) => RAISED_TOPIC[k].test(l)));
      text = head + kept.join("\n");
    }
  }

  const marks = record && record.marks;
  if (marks && normMark(marks.ice) === "O" && Array.isArray(history)) {
    const said = history
      .filter((h) => h.role === "user" && !CUE.test(String(h.text || "")))
      .map((h) => String(h.text || "").replace(/\([^)]*\)/g, " "));
    const all = [CHECKS.iceIdea, CHECKS.iceConcern, CHECKS.iceExpect].every((re) => said.some((t) => re.test(t)));
    if (all) text = text.replace(new RegExp(`^(${LEAD}ICE[^:：\\n]*[:：]\\s*(?:\\*\\*)?\\s*O)[^\\n]*$`, "m"), "$1 (생각·걱정·기대를 모두 질문함)");
  }
  return text;
}
