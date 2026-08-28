// 채점 결과 원문에서 항목별 O/△/X 를 읽어 "자주 놓친 항목" 을 집계한다.
// 파싱만 하고 화면은 모르므로, 브라우저 없이 노드에서 그대로 불러 검증할 수 있다.
// ---------- 채점 원문에서 항목별 O/△/X 읽기 ----------
// 채점 결과는 마크다운 표로 저장된다. 스킬이 열 순서까지 못박지는 않으므로
// 헤더 이름으로 먼저 찾고, 그것도 안 되면 O/△/X 가 가장 많이 든 열을 평가 열로 본다.
// 읽지 못한 기록은 조용히 버리지 않고 세어서 화면에 알린다.

function joinChunks(chunkArray, legacy) {
  if (Array.isArray(chunkArray) && chunkArray.length) return chunkArray.join("");
  return legacy || "";
}

// 표기 흔들림을 흡수한다 — 모델이 ○ 나 ✗ 로 적어도 같은 것으로 본다.
function readMark(s) {
  const t = String(s || "").trim();
  if (/^[Oo○◯✓✔]$/.test(t)) return "O";
  if (/^[△▲]$/.test(t)) return "H";
  if (/^[XxＸ×✗✘]$/.test(t)) return "X";
  return null;
}

// 항목명에서 배점·강조·체크박스를 걷어내 같은 항목이 같은 이름으로 모이게 한다.
function cleanItem(s) {
  return String(s || "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^\[.?\]\s*/, "")
    .replace(/\s*[(（]\s*\d+\s*점\s*[)）]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const isRow = (l) => /^\s*\|.*\|\s*$/.test(l || "");
const rowCells = (l) =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function parseEvaluation(md) {
  const src = String(md || "")
    .replace(/\r\n?/g, "\n")
    // 기록 블록은 점수를 넘기려고 붙는 JSON 이라 항목표가 아니다.
    .replace(/```cpx-record[\s\S]*?```/g, "");

  const lines = src.split("\n");
  const out = [];
  let section = "";

  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^#{1,6}\s+(.*)$/);
    if (h) {
      // "## I. 병력청취 — 32 / 60" → "병력청취"
      section = h[1]
        .replace(/\s*[—-].*$/, "")
        .replace(/^[IVXivx]+\.\s*/, "")
        .replace(/^\d+\.\s*/, "")
        .trim();
      continue;
    }

    // 표 = 헤더 줄 + |---|---| 구분선 + 본문 줄들
    if (!(isRow(lines[i]) && isRow(lines[i + 1]) && /^[\s|:-]+$/.test(lines[i + 1]))) continue;

    const head = rowCells(lines[i]);
    let markCol = head.findIndex((c) => /평가|채점|결과|점검|수행/.test(c));
    let nameCol = head.findIndex((c) => /항목|내용|질문/.test(c));
    if (nameCol < 0) nameCol = 0;

    i += 1;
    const body = [];
    while (isRow(lines[i + 1])) body.push(rowCells(lines[++i]));

    if (markCol < 0) {
      // 헤더로 못 찾으면 O/△/X 가 가장 많이 든 열을 평가 열로 본다.
      let best = -1;
      let bestN = 0;
      const width = Math.max(head.length, ...body.map((r) => r.length));
      for (let c = 0; c < width; c++) {
        const n = body.filter((r) => readMark(r[c])).length;
        if (n > bestN) {
          bestN = n;
          best = c;
        }
      }
      if (bestN === 0) continue; // 채점표가 아닌 표
      markCol = best;
    }

    for (const r of body) {
      const mark = readMark(r[markCol]);
      const item = cleanItem(r[nameCol]);
      if (!mark || !item) continue;
      out.push({ section, item, mark });
    }
  }

  return out;
}

// 기록 전체에서 항목별로 몇 번 나왔고 몇 번 놓쳤는지 센다. △ 는 0.5회로 친다.
export function aggregateMissed(scored) {
  const agg = new Map();
  let withText = 0;
  let parsed = 0;

  for (const r of scored) {
    const text = joinChunks(r.evaluationChunks, r.evaluationText);
    if (!text) continue;
    withText += 1;
    const items = parseEvaluation(text);
    if (items.length) parsed += 1;

    // 한 기록 안에 같은 항목이 두 번 나오면 한 번으로 친다.
    const seenHere = new Set();
    for (const it of items) {
      if (seenHere.has(it.item)) continue;
      seenHere.add(it.item);
      if (!agg.has(it.item)) {
        agg.set(it.item, { item: it.item, section: it.section, seen: 0, x: 0, half: 0 });
      }
      const e = agg.get(it.item);
      e.seen += 1;
      if (it.mark === "X") e.x += 1;
      else if (it.mark === "H") e.half += 1;
      if (!e.section && it.section) e.section = it.section;
    }
  }

  const missed = [...agg.values()]
    .map((e) => {
      const missCount = e.x + e.half * 0.5;
      return { ...e, missCount, rate: e.seen ? missCount / e.seen : 0 };
    })
    .filter((e) => e.missCount > 0)
    // 놓친 횟수가 먼저다 — 1회 중 1회 놓친 항목이 8회 중 6회 놓친 항목을 앞지르면 곤란하다.
    .sort((a, b) => b.missCount - a.missCount || b.rate - a.rate || a.item.localeCompare(b.item));

  return { missed, evalWithText: withText, evalParsed: parsed };
}
