// 기록 한 건을 사람이 읽을 형태로 바꾸고 파일로 내려준다.
// 화면을 모르는 순수 함수라 브라우저 없이 노드에서 그대로 검증할 수 있다.
//
// PDF 는 여기서 만들지 않는다. jsPDF 류로 직접 만들면 한글 폰트를 통째로 실어야 하고
// (수 MB) 안 실으면 글자가 깨진다. 대신 app.js 가 브라우저 인쇄로 넘긴다 —
// 의존성이 없고, 글자가 선택·검색되는 PDF 가 나온다. style.css 의 @media print 참고.

import { SECTIONS } from "./scoring.js";

const p2 = (n) => String(n).padStart(2, "0");

// 긴 텍스트는 Firestore 색인 제한 때문에 1500자씩 잘려 배열로 저장된다.
// (transcript / evaluationText 단일 문자열은 구버전 기록 호환용)
export function joinChunks(chunkArray, legacy) {
  if (Array.isArray(chunkArray) && chunkArray.length) return chunkArray.join("");
  return legacy || "";
}

export function fmtDateTime(ts) {
  if (!ts || !ts.toDate) return "";
  const d = ts.toDate();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

// 문진 전사는 학생이 "평가"를 입력하기 전까지만이다. 웹 면담은 예전에 "평가" 입력과 그 뒤에 나온 채점문까지
// 전사에 같이 저장했다 — 채점 결과는 "채점 결과" 탭에 따로 있으니, 이미 저장된 기록도 보여 줄 때 여기서 자른다.
const EVAL_CUE_LINE = /^(?:의사|학생|사용자|나)\s*[:：]\s*평가\s*$/m;
export function trimTranscript(script) {
  const s = String(script || "");
  const m = EVAL_CUE_LINE.exec(s);
  return m ? s.slice(0, m.index).trimEnd() : s;
}

// 채점문의 항목 줄("1. 도입 (5점): X (근거)", "ICE: O (근거)")을 읽어 표로 바꾼다. 항목 줄이 이어진 곳만 바꾸고,
// 이미 표가 있는 채점문(플러그인 기록)이나 항목 줄이 없는 글은 그대로 둔다. 배점이 없으면 채점표(scoring.js)에서 찾는다.
const MARK_WORD = { O: "O", "△": "△", X: "X", N: "해당없음", 해당없음: "해당없음" };
// 근거는 모델이 "(근거)" 로도, "| 근거" · "— 근거" · "- 근거" · ": 근거" 로도 쓴다 (실제로 형식이 바뀐 적이 있다).
// 앞의 것은 3번, 뒤의 것은 4번 그룹이다. 읽을 때는 commentOf 로 둘 중 있는 쪽을 쓴다.
const ITEM_LINE = /^\s*(?:\d+[.)]\s+|[-*•]\s+)?(.{1,60}?)\s*[:：]\s*\**\s*(O|△|X|N|해당없음)\**(?![A-Za-z가-힣])\s*(?:[(（](.*)[)）]|[|｜—–:：-]\s*(.*))?\s*$/;
// 근거 전체가 따옴표 하나로 감싸진 경우("…")에만 바깥 따옴표를 벗긴다. 안쪽에 따옴표가 섞인 근거(생각: "독감", …)는 그대로 둔다.
const commentOf = (m) => {
  const t = String(m[3] ?? m[4] ?? "").trim();
  const q = /^["“](.*)["”]$/.exec(t);
  return q && !/["“”]/.test(q[1]) ? q[1] : t;
};
const PE_KEYS = new Set(["consent", "vitals", "pe1", "pe2"]);

function lookupItem(label) {
  const clean = label.replace(/[(（]\s*\d+\s*점\s*[)）]/g, "").replace(/\*+/g, "").trim();
  const norm = (t) => t.replace(/\s+/g, "");
  for (const sec of SECTIONS) {
    for (const [key, name, pts] of sec.items) {
      const base = norm(name.split(" (")[0]);
      if (norm(clean).startsWith(base)) return { key, pts, label: clean };
    }
  }
  const m = label.match(/[(（]\s*(\d+)\s*점\s*[)）]/);
  return { key: null, pts: m ? Number(m[1]) : null, label: clean };
}

const cell = (t) => String(t || "").replace(/\|/g, "／").replace(/\s+/g, " ").trim();

export function tabulateEvaluation(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const run = [];
    while (i + run.length < lines.length) {
      const m = ITEM_LINE.exec(lines[i + run.length]);
      if (!m) break;
      run.push(m);
    }
    if (run.length < 2) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    out.push("| 항목 | 평가 | 점수 | 근거 |", "| --- | --- | --- | --- |");
    for (const m of run) {
      const info = lookupItem(m[1]);
      const mark = m[2];
      let score = "-";
      if (info.pts != null) {
        const ratio = mark === "O" ? 1 : mark === "△" ? 0.5 : mark === "X" ? 0 : PE_KEYS.has(info.key) ? 1 : 0.5;
        score = `${info.pts * ratio} / ${info.pts}`;
      }
      out.push(`| ${cell(info.label)} | ${MARK_WORD[mark]} | ${score} | ${cell(commentOf(m))} |`);
    }
    i += run.length;
  }
  return out.join("\n");
}

// 채점문의 항목 줄에서 [{label, mark, comment}] 를 뽑는다. 점수 표(scoring.js 가 계산)에 근거를 합칠 때 쓴다.
export function parseEvalItems(md) {
  const out = [];
  for (const line of String(md || "").split("\n")) {
    const m = ITEM_LINE.exec(line);
    if (m) out.push({ label: lookupItem(m[1]).label, mark: m[2], comment: commentOf(m) });
  }
  return out;
}

// 항목 줄(2개 이상 이어진 것)과 "I. 병력청취" 같은 구역 제목을 걷어 낸다 — 표로 합친 뒤에 같은 내용이 또 나오지 않게.
export function stripEvalItems(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; ) {
    let n = 0;
    while (i + n < lines.length && ITEM_LINE.test(lines[i + n])) n += 1;
    if (n >= 2) {
      i += n;
      continue;
    }
    // 구역 제목: "## I. 병력청취 (History taking)" 도, `#` 없는 "III. PPI (Patient-Physician Interaction) — 20점" 도 있다.
    if (/^\s*(?:#{1,6}\s*)?(?:I{1,3})\.\s*(?:병력\s*청취|신체\s*진찰|PPI)/.test(lines[i])) {
      i += 1;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 점수 표의 항목 이름("ICE (환자의 생각·걱정·기대)")에 맞는 근거를 찾는다. 채점문은 "ICE" 처럼 짧게 쓴다.
export function findReason(items, rowLabel) {
  const norm = (t) => String(t).replace(/\s+/g, "");
  const base = norm(String(rowLabel).split(" (")[0]);
  const hits = items.filter((it) => {
    const l = norm(it.label.split(" (")[0]);
    return l.startsWith(base) || base.startsWith(l);
  });
  return hits.map((h) => h.comment).filter(Boolean).join(" / ");
}

export function detailFilename(r, ext) {
  // 윈도·맥 양쪽에서 파일명에 못 쓰는 글자를 걷어낸다.
  const topic = (r.topic || "무작위").replace(/[\\/:*?"<>|]/g, "-").trim() || "무작위";
  const d = r.createdAt?.toDate ? r.createdAt.toDate() : null;
  const stamp = d ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : "날짜없음";
  return `CPX_${topic}_${stamp}.${ext}`;
}

export function recordToMarkdown(r) {
  const out = [`# ${r.topic || "무작위"}`, ""];

  const meta = [`- 일시: ${fmtDateTime(r.createdAt) || "기록 없음"}`];
  if (typeof r.totalScore === "number") meta.push(`- 총점: ${r.totalScore} / 100`);
  const sect = [
    ["병력청취", r.historyScore, 60],
    ["신체진찰", r.peScore, 20],
    ["PPI", r.ppiScore, 20],
  ].filter(([, v]) => typeof v === "number");
  if (sect.length) meta.push(`- 영역별: ${sect.map(([n, v, m]) => `${n} ${v}/${m}`).join(" · ")}`);
  if (r.grade) meta.push(`- 등급: ${r.grade}`);
  if (r.note) meta.push(`- 총평: ${r.note}`);
  out.push(...meta, "");

  // 기록 블록은 점수를 넘기려고 붙는 JSON 이라 사람이 읽을 것이 아니다.
  const evalText = joinChunks(r.evaluationChunks, r.evaluationText)
    .replace(/```cpx-record[\s\S]*?```/g, "")
    .trim();
  if (evalText) out.push("## 채점 결과", "", tabulateEvaluation(evalText), "");

  const script = trimTranscript(joinChunks(r.transcriptChunks, r.transcript)).trim();
  if (script) {
    out.push("## 문진 전사", "");
    if (r.transcriptTruncated) out.push("> 앞부분이 길어 잘린 전사입니다.", "");
    // 대화는 줄바꿈이 곧 뜻이라, 마크다운이 문단을 합치지 않게 코드 블록에 넣는다.
    // 전사 안에 백틱 울타리가 있으면 블록이 거기서 닫혀버리므로, 가장 긴 것보다 한 칸 긴 울타리를 쓴다.
    const longest = Math.max(2, ...[...script.matchAll(/^\s*(`{3,})/gm)].map((m) => m[1].length));
    const fence = "`".repeat(longest + 1);
    out.push(fence + "text", script, fence, "");
  }

  if (!evalText && !script) out.push("(채점 결과도 문진 전사도 저장되지 않은 기록입니다)", "");

  return out.join("\n");
}

export function downloadText(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 즉시 해제하면 저장이 시작되기 전에 URL 이 사라지는 브라우저가 있다.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
