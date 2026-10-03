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
