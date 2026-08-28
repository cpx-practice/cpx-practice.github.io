// 기록 한 건을 사람이 읽을 형태로 바꾸고 파일로 내려준다.
// 화면을 모르는 순수 함수라 브라우저 없이 노드에서 그대로 검증할 수 있다.
//
// PDF 는 여기서 만들지 않는다. jsPDF 류로 직접 만들면 한글 폰트를 통째로 실어야 하고
// (수 MB) 안 실으면 글자가 깨진다. 대신 app.js 가 브라우저 인쇄로 넘긴다 —
// 의존성이 없고, 글자가 선택·검색되는 PDF 가 나온다. style.css 의 @media print 참고.

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
  if (evalText) out.push("## 채점 결과", "", evalText, "");

  const script = joinChunks(r.transcriptChunks, r.transcript).trim();
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
