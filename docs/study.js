// 공부 탭 — 주제별 감별 진단, 진단마다 핵심 단서, 채점표를 보여 준다.
// 자료는 scripts/build-study.mjs 가 cpx-worker 의 카드와 채점표에서 미리 만든 docs/study/*.json 이다(면담 서버를 쓰지 않는다).
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { matchTopic } from "./topics.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => escapeHtml(String(s ?? ""));

// 채점표는 scripts/build-study.mjs 가 학생용으로 손질해 둔 것이다(채점자용 설명·시나리오 ID 제거).
const studentChecklist = (md) => String(md || "");

function scenarioCard(s, i) {
  const flags = s.flags && s.flags.length
    ? `<ul class="study-flags">${s.flags.map((f) => `<li><span class="q">${esc(f.q)}</span> → ${esc(f.a)}</li>`).join("")}</ul>`
    : "";
  // 현병력·증상·소견은 위의 비교표에 있으므로 카드에는 문답만 둔다.
  const body = flags || `<p class="hint">이 진단은 따로 정리된 문답이 없습니다. 위 비교표를 보세요.</p>`;
  return `<details class="study-card"${i === 0 ? "" : ""}><summary><b>${esc(s.dx)}</b></summary>${body}</details>`;
}

// 진단을 열로, 단서를 행으로 놓은 비교표 — 카드에서 자동으로 만들어 모든 주제에 쓴다.
function matrixHtml(scenarios) {
  const hpi = (s, label) => (s.hpi.find((h) => h.label === label) || {}).text || "";
  const join = (arr) => (arr || []).join(" · ");
  const R = [
    ["환자", (s) => s.who],
    ["첫마디", (s) => (s.opening ? `“${s.opening}”` : "")],
    ["발병", (s) => hpi(s, "발병")],
    ["양상", (s) => hpi(s, "양상")],
    ["위치", (s) => hpi(s, "위치")],
    ["방사", (s) => hpi(s, "방사")],
    ["악화 요인", (s) => hpi(s, "악화 요인")],
    ["완화 요인", (s) => hpi(s, "완화 요인")],
    ["경과", (s) => hpi(s, "경과")],
    ["있는 증상", (s) => join(s.positive)],
    ["없는 증상", (s) => join(s.negative)],
    ["과거력·약", (s) => s.history.map((h) => `${h.label}: ${h.text}`).join(" / ")],
    ["활력징후", (s) => join(s.vitals)],
    ["이상 진찰 소견", (s) => s.pe.map((p) => `${p.label}: ${p.text}`).join(" / ")],
  ];
  const body = R.map(([label, get]) => {
    const cells = scenarios.map(get);
    if (cells.every((c) => !c)) return ""; // 어느 진단에도 없는 행은 뺀다
    return `<tr><th>${esc(label)}</th>${cells.map((c) => `<td>${esc(c) || '<span class="muted">—</span>'}</td>`).join("")}</tr>`;
  }).join("");
  // 하나씩 보기 — 휴대폰에서 넓은 표를 옆으로 밀지 않고, 진단을 골라 그 진단의 단서를 위아래로 본다.
  const rows = R.filter(([, get]) => scenarios.some((s) => get(s)));
  const one = scenarios
    .map(
      (s, i) =>
        `<dl class="mx-one${i === 0 ? " on" : ""}" data-i="${i}">` +
        rows.map(([label, get]) => `<dt>${esc(label)}</dt><dd>${esc(get(s)) || '<span class="muted">—</span>'}</dd>`).join("") +
        `</dl>`
    )
    .join("");
  return (
    `<div class="mx" data-mode="${matrixMode()}">` +
    `<div class="mx-bar"><span class="seg" role="group" aria-label="보는 방식">` +
    `<button type="button" class="seg-btn" data-mx-mode="one">하나씩</button><button type="button" class="seg-btn" data-mx-mode="all">전체</button></span></div>` +
    `<div class="mx-dx" role="tablist">${scenarios.map((s, i) => `<button type="button" class="mx-dx-btn${i === 0 ? " on" : ""}" data-mx-dx="${i}" role="tab">${esc(s.dx)}</button>`).join("")}</div>` +
    `<div class="mx-ones">${one}</div>` +
    `<div class="table-wrap matrix-wrap"><table class="study-table matrix-table" style="--cols:${scenarios.length}">` +
    `<thead><tr><th></th>${scenarios.map((s) => `<th>${esc(s.dx)}</th>`).join("")}</tr></thead>` +
    `<tbody>${body}</tbody></table></div></div>`
  );
}

// 진단별 단서 비교를 하나씩 볼지 전체 표로 볼지 — 마지막 선택을 기억하고, 처음이면 휴대폰은 하나씩, 넓은 화면은 전체.
const MX_KEY = "cpx-study-mx";
function matrixMode() {
  try {
    const v = localStorage.getItem(MX_KEY);
    if (v === "one" || v === "all") return v;
  } catch {
    /* 저장소를 못 쓰면 화면 폭으로 정한다 */
  }
  return window.matchMedia && window.matchMedia("(max-width: 640px)").matches ? "one" : "all";
}
function setMatrixMode(v) {
  try {
    localStorage.setItem(MX_KEY, v);
  } catch {
    /* 이번 화면에서만 적용 */
  }
}

// 주제 화면 위의 바로가기 — 한 페이지가 길어 원하는 부분까지 한참 내려야 했다. 위에 붙어 따라온다(style.css .st-jump).
function jumpNav(d) {
  const g = d.guide || {};
  const items = [
    g.summary && ["st-summary", "한눈에"],
    (g.script?.length && ["st-script", "면담 순서"]) || (g.flow?.length && ["st-flow", "면담 흐름"]),
    g.compare?.rows?.length && ["st-compare", "비교표"],
    g.pitfalls?.length && ["st-pitfalls", "놓치기 쉬운 것"],
    ["st-matrix", "단서 비교"],
    ["st-qa", "문답"],
    ["st-rubric", "채점 기준"],
  ].filter(Boolean);
  return `<nav class="st-jump" aria-label="이 주제 바로가기">${items.map(([id, label]) => `<a href="#" data-jump="${id}">${esc(label)}</a>`).join("")}</nav>`;
}

// 사람이 쓴 면담 가이드 — 한눈에 보기, 단계별 질문 흐름, 감별 비교표, 놓치기 쉬운 것.
function guideHtml(g) {
  if (!g) return "";
  const sm = g.summary || {};
  const summary =
    `<div class="guide-summary">` +
    // 항목 안에도 "고령·흡연"처럼 가운뎃점이 있어, " · "로 이어 붙이면 어디서 끊기는지 읽기 어려웠다 — 응급은 한 줄씩, 흔한 원인은 칩으로.
    (sm.emergency?.length
      ? `<div class="guide-row"><span class="tag tag-danger">먼저 가릴 응급</span><ul class="guide-emergency">${sm.emergency.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`
      : "") +
    (sm.common?.length
      ? `<div class="guide-row"><span class="tag">흔한 원인</span><span class="guide-chips">${sm.common.map((x) => `<span class="guide-chip">${esc(x)}</span>`).join("")}</span></div>`
      : "") +
    (sm.strategy ? `<p class="guide-strategy">${esc(sm.strategy)}</p>` : "") +
    `</div>`;
  // 면담 흐름 — 한 단계가 여러 줄(답에 따른 갈래)을 차지하는 표. 단계·질문 칸은 rowspan 으로 묶는다.
  const flow = (g.flow || [])
    .map((f, i) => {
      const sorts = f.sorts && f.sorts.length ? f.sorts : [{ if: "", then: "" }];
      const n = sorts.length;
      const head =
        `<th rowspan="${n}" class="flow-step"><span class="guide-num">${i + 1}</span> ${esc(f.step)}` +
        (f.why ? `<div class="flow-why">${esc(f.why)}</div>` : "") +
        `</th>` +
        `<td rowspan="${n}" class="flow-ask">${(f.ask || []).map((q) => `<div>“${esc(q)}”</div>`).join("")}</td>`;
      return sorts
        .map((x, j) => `<tr${j === 0 ? ' class="flow-first"' : ""}>${j === 0 ? head : ""}<td>${esc(x.if)}</td><td class="flow-dx">${esc(x.then)}</td></tr>`)
        .join("");
    })
    .join("");
  // 면담 순서 — 실제로 물을 순서대로 A(도입)→G(마무리) 카테고리별 질문 목록. 번호는 카테고리를 넘어 이어진다.
  // ext 는 카드에 없어도 이 질문으로 배제해야 하는 질환이다.
  let qn = 0;
  // 가이드 질문은 한 줄에 여러 질문이 묶여 있는 경우가 많다. 실제 면담에서는 하나씩 묻도록
  // 물음표마다 줄을 나누고, 여러 항목을 쉼표·"~이나"로 나열한 문장에는 "하나씩" 표시를 붙인다.
  // ("A인가요, B인가요?" 같은 양자택일 질문과 안내 문장은 표시하지 않는다.)
  const qLines = (q) =>
    (String(q).match(/[^?？]+[?？]?/g) || [])
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const list = /[?？]$/.test(s) && !/^\(|안녕|입니다\./.test(s) && !/요\s*[,，]|듯\s*[,，]/.test(s) &&
          /[,，]|[가-힣]이나\s/.test(s);
        return `<div class="script-q">“${esc(s)}”${list ? ' <span class="one-by-one" title="실제 면담에서는 항목을 하나씩 따로 묻습니다">하나씩</span>' : ""}</div>`;
      })
      .join("");
  const script = (g.script || [])
    .map(
      (cat) =>
        `<section class="script-cat" id="st-cat-${esc(cat.cat)}">` +
        `<h4><span class="cat-letter">${esc(cat.cat)}</span> ${esc(cat.title)}</h4>` +
        (cat.note ? `<p class="hint">${esc(cat.note)}</p>` : "") +
        `<ol class="script-qs" start="${qn + 1}">` +
        (cat.qs || [])
          .map((x) => {
            qn++;
            return (
              `<li${x.hint || x.ext?.length ? ' class="has-note"' : ""}>${qLines(x.q)}` +
              (x.hint ? `<div class="script-hint">${esc(x.hint)}</div>` : "") +
              (x.ext?.length ? `<div class="script-ext"><span class="script-ext-label">배제</span>${x.ext.map((d) => `<span class="tag tag-danger">${esc(d)}</span>`).join("")}</div>` : "") +
              `</li>`
            );
          })
          .join("") +
        `</ol></section>`
    )
    .join("");
  const c = g.compare;
  const compare = c && c.rows?.length
    ? `<div class="table-wrap"><table class="guide-compare"><thead><tr><th>진단</th>${c.cols.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>` +
      // data-label — 좁은 화면에서 표를 진단별 카드로 접을 때 칸 이름으로 쓴다 (style.css .guide-compare).
      c.rows.map((r) => `<tr><th>${esc(r.dx)}</th>${r.cells.map((x, i) => `<td data-label="${esc(c.cols[i] || "")}">${esc(x)}</td>`).join("")}</tr>`).join("") +
      `</tbody></table></div>` +
      // 카드에서 확률로 나오는 소견(면담마다 있을 수도 없을 수도)은 표에 ± 를 붙여 두었다.
      (c.rows.some((r) => r.cells.some((x) => String(x).includes("±")))
        ? `<p class="hint">± 표시 소견은 환자에 따라 있을 수도, 없을 수도 있습니다. 없다고 진단을 버리지 마세요.</p>`
        : "")
    : "";
  const pit = (g.pitfalls || []).length ? `<ul class="guide-pitfalls">${g.pitfalls.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
  return (
    `<h3 id="st-summary">한눈에 보기</h3>${summary}` +
    (script
      ? `<h3 id="st-script">면담 순서</h3><p class="hint">실제로 물을 순서입니다. 질문 아래 작은 글씨는 답에 따라 생각할 진단, 빨간 <b>배제</b> 표시는 이 주제의 출제 진단이 아니어도 그 질문으로 꼭 지워야 하는 질환입니다.</p>` +
        `<p class="guide-callout">실제 면담에서는 <b>한 번에 하나씩</b> 묻습니다. 여기 한 번호에 묶인 질문과 <span class="one-by-one">하나씩</span> 표시가 붙은 항목은 확인할 내용을 모아 둔 것이니, 면담 때는 따로따로 물어 보세요. 한 문장에 두세 개를 묶어 물으면 채점에서 감점됩니다.</p>` +
        `<label class="script-toggle"><input type="checkbox" id="stHideToggle"${hideOn() ? " checked" : ""}> 가리기 모드 <span class="hint">— 해설을 가리고, 질문을 눌러 확인합니다</span></label>` +
        `<div class="script${hideOn() ? " hide-hints" : ""}" id="stScript">${script}</div>`
      : "") +
    (!script && flow
      ? `<h3 id="st-flow">면담 흐름</h3><p class="hint">위에서 아래 순서로 묻습니다. 환자의 답에 따라 오른쪽 진단 쪽으로 좁혀집니다.</p>` +
        `<div class="table-wrap"><table class="study-table flow-table"><colgroup><col class="c-step"><col class="c-ask"><col class="c-if"><col class="c-dx"></colgroup><thead><tr><th>단계</th><th>이렇게 묻는다</th><th>이런 답이면</th><th>생각할 진단</th></tr></thead><tbody>${flow}</tbody></table></div>`
      : "") +
    (compare ? `<h3 id="st-compare">감별 비교표</h3>${compare}` : "") +
    (pit ? `<h3 id="st-pitfalls">놓치기 쉬운 것</h3>${pit}` : "")
  );
}

// 가리기 모드 — 면담 순서의 해설·배제 질환을 가리고 질문을 눌러 하나씩 확인한다. 켜 둔 상태는 이 브라우저에만 기억한다.
const HIDE_KEY = "cpx.study.hide";
function hideOn() {
  try {
    return localStorage.getItem(HIDE_KEY) === "1";
  } catch {
    return false;
  }
}
function setHide(on) {
  try {
    localStorage.setItem(HIDE_KEY, on ? "1" : "0");
  } catch {
    /* 저장이 막힌 브라우저에서도 이번 화면에서는 동작한다 */
  }
}

// 주제 목록 화면의 계통 묶음. 공부 자료의 주제 이름(topics.js 의 이름)으로 묶는다.
// 여기에 없는 주제는 맨 끝 "기타"로 간다 — 주제가 늘어도 화면에서 빠지지 않게.
const TOPIC_GROUPS = [
  ["심장·혈관", ["가슴통증", "고혈압", "두근거림", "실신", "이상지질혈증"]],
  ["호흡", ["객혈", "기침", "호흡곤란", "콧물/코막힘"]],
  ["소화기", ["구토", "복통", "소화불량", "배변 이상(변비)", "배변 이상(설사)", "토혈", "혈변", "황달"]],
  ["신경", ["경련", "근력/감각 이상", "기억력 저하", "두통", "떨림/운동이상", "어지럼", "의식장애"]],
  ["근골격·피부", ["관절통증/부기", "목통증/허리통증", "피부 발진"]],
  ["신장·비뇨", ["배뇨 이상", "붉은색 소변", "소변량변화(다뇨증)", "소변량변화(핍뇨)"]],
  ["전신·내분비", ["발열", "체중 감소", "체중 증가/비만", "피로", "쉽게 멍이 듦"]],
  ["여성·임신", ["월경이상", "월경통", "질 분비물/질 출혈", "유방통", "유방덩이", "산전 진찰"]],
  ["소아", ["성장 지연", "발달 지연", "예방접종"]],
  ["정신·상담", ["기분 변화", "불안", "수면장애", "자살", "물질오남용", "음주 상담", "금연 상담", "가정폭력", "성폭력"]],
];

// 기록을 주제별로 모은다 — {횟수, 최고 점수}. 기록의 topic 은 모델이 적은 값이라 matchTopic 으로 맞춘다.
function practiceByTopic(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const t = matchTopic(r.topic);
    if (!t) continue;
    const cur = by.get(t.name) || { count: 0, best: null };
    cur.count++;
    if (typeof r.totalScore === "number" && (cur.best === null || r.totalScore > cur.best)) cur.best = r.totalScore;
    by.set(t.name, cur);
  }
  return by;
}

const band = (v) => (v >= 90 ? 4 : v >= 80 ? 3 : v >= 70 ? 2 : 1);

// 주제를 고르기 전 첫 화면 — 계통별 카드와 진도.
function gridHtml(topics, rows) {
  const stats = practiceByTopic(rows);
  const byName = new Map(topics.map((t) => [t.name, t]));
  const used = new Set();
  const groups = TOPIC_GROUPS.map(([g, names]) => [g, names.map((n) => byName.get(n)).filter(Boolean)]);
  for (const [, list] of groups) list.forEach((t) => used.add(t.name));
  const rest = topics.filter((t) => !used.has(t.name));
  if (rest.length) groups.push(["기타", rest]);

  const done = topics.filter((t) => stats.get(t.name)?.count).length;
  const pct = topics.length ? Math.round((done / topics.length) * 100) : 0;
  const card = (t) => {
    const st = stats.get(t.name);
    const meta = st
      ? `<span class="tg-count">${st.count}회</span>${st.best !== null ? `<span class="score-chip b${band(st.best)}">${st.best}</span>` : ""}`
      : `<span class="tg-new">미연습</span>`;
    return `<button type="button" class="tg-card${st ? "" : " is-new"}" data-key="${esc(t.key)}">` +
      `<span class="tg-name">${esc(t.name)}</span>` +
      `<span class="tg-sub">감별 ${t.count}</span>` +
      `<span class="tg-meta">${meta}</span></button>`;
  };
  return (
    `<div class="tg-progress"><div class="tg-progress-text"><b>${done} / ${topics.length}</b> 주제 연습 · ${pct}%</div>` +
    `<div class="tg-bar"><span style="width:${pct}%"></span></div></div>` +
    groups
      .filter(([, list]) => list.length)
      .map(([g, list]) => `<section class="tg-group"><h3>${esc(g)}</h3><div class="tg-grid">${list.map(card).join("")}</div></section>`)
      .join("")
  );
}

// 결과 창 복습 링크 → 공부 탭 위치. 앞에 있는 것부터 찾아 처음 있는 곳으로 간다.
const SECTION_TARGETS = {
  hpi: ["st-cat-B", "st-flow"],
  redflag: ["st-cat-D", "st-summary"],
  pmh: ["st-cat-E", "st-flow"],
  flow: ["st-script", "st-flow"],
};

export function initStudyTab({ onStartInterview, canInterview, getRecords } = {}) {
  const select = $("stTopic");
  const body = $("stBody");
  const startBtn = $("stStart");
  if (!select || !body) return { refresh() {} };
  let indexReady = null; // 목록은 한 번만 받는다. 결과 창에서 바로 열 때도 목록이 다 찬 뒤에 고르도록 promise 를 나눠 쓴다.
  let current = null;
  let topics = []; // study/index.json 의 주제 목록
  // 주제 자료는 한 번 받으면 이 페이지에서는 다시 받지 않는다. 예전에는 열 때마다 서버에 다시 물어
  // (cache: no-cache) 0.2~0.5초, 휴대폰 회선에서는 몇 초씩 "불러오는 중…"이 떠 있었다 (2026-11-24).
  // 카드에 손가락·마우스가 닿는 순간 미리 받기 시작해, 누를 때쯤에는 대개 받아져 있다.
  const topicCache = new Map(); // key → Promise<자료>
  function getTopic(key) {
    if (!topicCache.has(key)) {
      const p = fetch(`study/${encodeURIComponent(key)}.json`, { cache: "no-cache" })
        .then((res) => {
          if (!res.ok) throw new Error(`study_${res.status}`);
          return res.json();
        })
        .catch((err) => {
          topicCache.delete(key); // 실패는 기억하지 않는다 — 다음에 다시 받는다
          throw err;
        });
      topicCache.set(key, p);
    }
    return topicCache.get(key);
  }

  function loadIndex() {
    indexReady ||= fetchIndex();
    return indexReady;
  }
  async function fetchIndex() {
    try {
      const res = await fetch("study/index.json", { cache: "no-cache" });
      const data = await res.json();
      topics = data.topics || [];
      for (const t of topics) {
        const opt = document.createElement("option");
        opt.value = t.key;
        opt.textContent = `${t.name} (${t.count})`;
        opt.dataset.name = t.name;
        select.appendChild(opt);
      }
    } catch (err) {
      indexReady = null;
      body.innerHTML = `<p class="err">공부 자료를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.</p>`;
      console.warn("공부 자료 목록 실패", err);
    }
  }

  async function show(key) {
    current = null;
    // 주제 카드 화면에서는 드롭다운이 카드와 겹치므로 숨기고, 주제를 연 뒤에만 "다른 주제"로 보인다.
    $("stTopicWrap")?.classList.toggle("hidden", !key);
    startBtn?.classList.add("hidden");
    if (!key) {
      await loadIndex();
      if (select.value) return; // 그새 주제를 골랐다
      body.innerHTML = topics.length
        ? gridHtml(topics, getRecords ? getRecords() : [])
        : `<p class="hint">주제를 고르면 감별 진단과 진단마다 핵심 단서, 채점표가 나옵니다.</p>`;
      return;
    }
    if (!topicCache.has(key)) body.innerHTML = `<p class="hint">불러오는 중…</p>`;
    try {
      const d = await getTopic(key);
      if (select.value !== key) return; // 그새 다른 주제를 골랐다
      current = d;
      // 가이드가 있으면 질문 흐름과 비교표가 중심이고, 진단별 카드는 "자세히", 채점표는 접어 둔다.
      // 가이드가 아직 없는 주제는 감별 목록과 진단별 카드가 중심이다.
      const dxList = `<ol class="study-dx">${d.scenarios.map((s) => `<li>${esc(s.dx)}</li>`).join("")}</ol>`;
      body.innerHTML =
        `<button type="button" class="btn ghost small st-back" id="stBack">← 주제 목록</button>` +
        jumpNav(d) +
        (d.guide
          ? guideHtml(d.guide)
          : `<h3>감별 진단 ${d.scenarios.length}가지</h3>${dxList}<p class="hint">면담에서는 이 가운데 하나가 무작위로 나옵니다. 이 주제의 면담 흐름 가이드는 준비 중입니다.</p>`) +
        `<h3 id="st-matrix">진단별 단서 비교</h3><p class="hint">면담에서 환자가 실제로 말하는 내용과 진찰 소견입니다. 진단을 하나씩 골라 보거나, 전체 표로 견주어 볼 수 있습니다.</p>` +
        matrixHtml(d.scenarios) +
        `<h3 id="st-qa">진단별 문답</h3><p class="hint">진단마다 꼭 물어야 하는 질문과 환자의 답입니다.</p>` +
        d.scenarios.map(scenarioCard).join("") +
        `<details class="study-card study-rubric" id="st-rubric"><summary>채점 기준 보기${d.commonChecklist ? " (공통)" : ""}</summary>` +
        `<p class="hint">면담 뒤 평가에 쓰는 표입니다. 위의 흐름을 익힌 뒤 확인용으로 보세요.</p>` +
        `<div class="study-checklist md">${renderMarkdown(studentChecklist(d.checklist))}</div></details>`;
      if (canInterview && canInterview()) startBtn?.classList.remove("hidden");
    } catch (err) {
      body.innerHTML = `<p class="err">이 주제의 공부 자료를 불러오지 못했습니다.</p>`;
      console.warn("공부 자료 실패", key, err);
    }
  }

  select.addEventListener("change", () => show(select.value));
  // 가리기 모드: 스위치를 바꾸면 펼쳐 둔 것도 다시 가린다. 켜져 있을 때 질문을 누르면 그 질문만 펼치고 접는다.
  body.addEventListener("change", (e) => {
    if (e.target.id !== "stHideToggle") return;
    const on = e.target.checked;
    setHide(on);
    const s = $("stScript");
    s?.classList.toggle("hide-hints", on);
    s?.querySelectorAll("li.revealed").forEach((li) => li.classList.remove("revealed"));
  });
  const prefetch = (e) => {
    const card = e.target.closest && e.target.closest(".tg-card[data-key]");
    if (card) getTopic(card.dataset.key).catch(() => {});
  };
  body.addEventListener("pointerover", prefetch);
  body.addEventListener("touchstart", prefetch, { passive: true });
  body.addEventListener("click", (e) => {
    const li = e.target.closest(".script.hide-hints .script-qs li.has-note");
    if (li) li.classList.toggle("revealed");
    // 주제 카드 → 그 주제 열기, "← 주제 목록" → 카드 화면으로
    const card = e.target.closest(".tg-card");
    if (card) {
      select.value = card.dataset.key;
      show(card.dataset.key);
      window.scrollTo({ top: 0 });
    }
    // 바로가기 — 해시를 바꾸지 않고(#study 라우팅 유지) 그 부분으로 스크롤한다. 채점 기준은 펼쳐서 보여 준다.
    const jump = e.target.closest("[data-jump]");
    if (jump) {
      e.preventDefault();
      const el = $(jump.dataset.jump);
      if (el) {
        if (el.tagName === "DETAILS") el.open = true;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    // 진단별 단서 비교 — 하나씩/전체 전환, 하나씩일 때 진단 고르기
    const mode = e.target.closest("[data-mx-mode]");
    if (mode) {
      const box = mode.closest(".mx");
      box.dataset.mode = mode.dataset.mxMode;
      setMatrixMode(mode.dataset.mxMode);
    }
    const dx = e.target.closest("[data-mx-dx]");
    if (dx) {
      const box = dx.closest(".mx");
      box.querySelectorAll(".mx-dx-btn").forEach((b) => b.classList.toggle("on", b === dx));
      box.querySelectorAll(".mx-one").forEach((dl) => dl.classList.toggle("on", dl.dataset.i === dx.dataset.mxDx));
    }
    if (e.target.closest("#stBack")) {
      select.value = "";
      show("");
    }
  });
  startBtn?.addEventListener("click", () => {
    if (current && onStartInterview) onStartInterview(current.name);
  });

  return {
    // 탭을 열 때 부른다 — 목록은 처음 한 번만 받는다.
    refresh() {
      loadIndex();
      if (!select.value) show("");
    },
    // 기록이 바뀌면(처음 불러올 때 포함) 주제 카드의 연습 횟수·점수를 다시 그린다. 주제를 열어 둔 중이면 건드리지 않는다.
    recordsChanged() {
      if (!select.value && topics.length) show("");
    },
    // 면담 결과 창의 "복습" 링크가 부른다 — 주제 이름(카드의 topic)으로 주제를 고르고, 가이드의 해당 부분으로 내려간다.
    // section: 채점 항목 쪽 이름(hpi·redflag·pmh) 또는 가이드 부분 이름(summary·compare·pitfalls).
    // 면담 순서(script) 가이드면 해당 카테고리로, 아직 예전 흐름 표인 주제면 흐름 표·한눈에 보기로 간다. 가이드가 없으면 맨 위.
    async open(topicName, section) {
      await loadIndex();
      const opt = [...select.options].find((o) => o.dataset.name === topicName);
      if (!opt) return;
      select.value = opt.value;
      await show(opt.value);
      const target = (SECTION_TARGETS[section] || [`st-${section}`]).map((id) => $(id)).find(Boolean);
      if (!target) return;
      // 부드러운 스크롤은 결과 창을 닫고 탭을 바꾸는 중에 끊겨 제자리에 머무는 일이 있었다 — 한 프레임 뒤 바로 옮긴다.
      await new Promise((r) => setTimeout(r, 0)); // requestAnimationFrame 은 창이 가려져 있으면 멈춘다
      target.scrollIntoView({ block: "start" });
      target.classList.add("st-flash");
      setTimeout(() => target.classList.remove("st-flash"), 2000);
    },
  };
}
