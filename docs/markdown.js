// 아주 작은 마크다운 렌더러 — 채점 결과(제목·표·목록·굵게·인라인 코드)만 다룬다.
// 외부 라이브러리 없이 필요한 문법만 직접 렌더링한다. 모든 조각을 escapeHtml 로
// 먼저 통과시키므로 저장된 내용이 HTML 로 실행될 여지는 없다.
// app.js(기록 상세 모달)와 interview.js(면담 채점 말풍선)가 같이 쓴다.

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function renderMarkdown(md) {
  const src = String(md || "")
    .replace(/\r\n?/g, "\n")
    // 기록 블록은 점수를 저장하기 위한 것이라 화면에 보여줄 필요가 없다.
    .replace(/```cpx-record[\s\S]*?```/g, "");

  const lines = src.split("\n");
  const html = [];
  let para = [];
  let list = null;

  const inline = (s) =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((i) => `<li>${inline(i)}</li>`).join("");
      html.push(`<${list.tag}>${items}</${list.tag}>`);
      list = null;
    }
  };
  const flush = () => {
    flushPara();
    flushList();
  };

  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l || "");
  const cells = (l) =>
    l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 표 = 헤더 줄 + |---|---| 구분선 + 본문 줄들
    if (isRow(line) && isRow(lines[i + 1]) && /^[\s|:-]+$/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 1;
      const body = [];
      while (isRow(lines[i + 1])) body.push(cells(lines[++i]));
      const thead = head.map((c) => `<th>${inline(c)}</th>`).join("");
      const tbody = body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("");
      html.push(
        `<div class="table-scroll"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      // 모달 제목이 h3 이므로 한 단계씩 낮춰 붙인다.
      const level = Math.min(heading[1].length + 1, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(---+|===+|\*\*\*+)\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (!list || list.tag !== "ul") {
        flushList();
        list = { tag: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      flushPara();
      if (!list || list.tag !== "ol") {
        flushList();
        list = { tag: "ol", items: [] };
      }
      list.items.push(numbered[1]);
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  flush();
  return html.join("\n");
}
