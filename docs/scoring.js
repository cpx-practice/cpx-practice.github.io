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

function normMark(v) {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "O" || s === "○") return "O";
  if (s === "△" || s === "Δ" || s === "▲" || s === "TRIANGLE") return "△";
  if (s === "X") return "X";
  if (s === "N" || s === "N/A" || s === "-") return "N";
  return null;
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
      const m = normMark(marks[k]) || "X";
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
  selfIntro: /(저는|제\s*이름은|담당|의사|학생).{0,20}(입니다|이에요|예요|라고\s*합니다)/,
  idCheck: /(성함|이름|나이|연세|생년월일)/,
  iceIdea: /(원인|생각하세요|생각하시|짚이는|때문인\s*것\s*같|뭐\s*때문|왜\s*그런)/,
  iceConcern: /걱정/,
  iceExpect: /(바라|원하시|원하세요|기대|도움을\s*받|어떤\s*도움|해\s*드렸으면)/,
  summary: /(정리하면|정리해\s*보면|정리해\s*드리|요약하면|요약해\s*보면|말씀하신\s*(내용|걸|것)|맞나요|맞으세요|맞으신가요|맞으시죠)/,
  closing: /(수고하셨|수고\s*많으셨|안녕히|조심히|들어가세요|다음에\s*뵙|다시\s*뵙|감사합니다|고맙습니다)/,
  consent: /(괜찮으|해도\s*될까|해도\s*되|하겠습니다|보겠습니다|볼게요|할게요|진찰을\s*위해|양해)/,
  safety: /(심해지|악화|다시\s*오|내원|응급실|바로\s*오|연락|생기면|나타나면|안\s*나오면)/,
  weight: /(체중|몸무게|살이\s*빠|살\s*빠|살이\s*줄)/,
};
const ORDER = { X: 0, "△": 1, O: 2 };

/**
 * history: [{role:"user"|"assistant", text}] — 평가 직전까지의 대화.
 * record.marks 를 제자리에서 낮추고, 바꾼 내역 [{label, from, to, reason}] 을 돌려준다.
 */
export function auditMarks(record, history) {
  const marks = record && record.marks;
  if (!marks || !Array.isArray(history)) return [];
  const turns = history.filter((h) => h.role === "user").map((h) => String(h.text || ""));
  const said = turns.filter((t) => !CUE.test(t)).map((t) => t.replace(/\([^)]*\)/g, " "));
  const peStart = turns.findIndex((t) => /^\s*진찰\s*$/.test(t) || PAREN_EXAM.test(t));
  const any = (re, list = said) => list.some((t) => re.test(t));
  const changes = [];
  const cap = (key, to, reason) => {
    const from = normMark(marks[key]);
    if (!from || from === "N" || ORDER[from] <= ORDER[to]) return;
    marks[key] = to;
    const label = SECTIONS.flatMap((s) => s.items).find(([k]) => k === key)?.[1] || key;
    changes.push({ label, from, to, reason });
  };

  const early = said.slice(0, 4);
  const intro = [any(CHECKS.selfIntro, early), any(CHECKS.idCheck, said.slice(0, 6))];
  if (!intro[0] || !intro[1]) {
    cap("intro", "△", [!intro[0] && "자기소개", !intro[1] && "환자 확인(성함·나이)"].filter(Boolean).join("·") + " 발화 없음");
  }

  const ice = [["생각(원인)", CHECKS.iceIdea], ["걱정", CHECKS.iceConcern], ["기대", CHECKS.iceExpect]];
  const missingIce = ice.filter(([, re]) => !any(re)).map(([n]) => n);
  if (missingIce.length === 3) cap("ice", "X", "생각·걱정·기대를 묻는 질문 없음");
  else if (missingIce.length) cap("ice", "△", `${missingIce.join("·")} 질문 없음`);

  // 전신증상(체중감소·발열·야간발한) 중 체중은 거의 모든 케이스에서 물어야 하는데 모델이 묻지 않아도 O 를 줬다.
  if (!any(CHECKS.weight)) cap("redflag", "△", "전신증상 중 체중 변화 질문 없음");
  if (!any(CHECKS.summary)) cap("summary", "X", "환자 말을 정리해 확인하는 발화 없음");
  if (!any(CHECKS.safety)) cap("safety", "X", "악화 시 대처·재방문 안내 발화 없음");
  if (!any(CHECKS.closing, said.slice(-3))) cap("closing", "X", "끝인사 없음");

  if (peStart >= 0) {
    // 진찰 신호 직전 말부터 첫 진찰 동작까지에서 설명·동의를 찾는다 — 진찰이 끝난 뒤의
    // "피검사 해볼게요" 같은 말은 진찰 전 동의가 아니다.
    let firstAct = turns.findIndex((t, i) => i >= peStart && PAREN_EXAM.test(t));
    if (firstAct < 0) firstAct = turns.findIndex((t, i) => i > peStart && !CUE.test(t));
    const end = firstAct < 0 ? turns.length : firstAct + 1;
    const around = turns.slice(Math.max(0, peStart - 1), end).filter((t) => !CUE.test(t)).map((t) => t.replace(/\([^)]*\)/g, " "));
    if (!any(CHECKS.consent, around)) cap("consent", "X", "진찰 전 설명·동의 발화 없음");
  }
  return changes;
}
