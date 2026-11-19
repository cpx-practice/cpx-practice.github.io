// 공부 탭 — 주제별 감별 진단, 진단마다 핵심 단서, 채점표를 보여 준다.
// 자료는 scripts/build-study.mjs 가 플러그인 카드와 채점표에서 미리 만든 docs/study/*.json 이다(면담 서버를 쓰지 않는다).
import { escapeHtml, renderMarkdown } from "./markdown.js";

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
  return (
    `<div class="table-wrap matrix-wrap"><table class="study-table matrix-table" style="--cols:${scenarios.length}">` +
    `<thead><tr><th></th>${scenarios.map((s) => `<th>${esc(s.dx)}</th>`).join("")}</tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

// 사람이 쓴 면담 가이드 — 한눈에 보기, 단계별 질문 흐름, 감별 비교표, 놓치기 쉬운 것.
function guideHtml(g) {
  if (!g) return "";
  const sm = g.summary || {};
  const summary =
    `<div class="guide-summary">` +
    (sm.emergency?.length ? `<p><span class="tag tag-danger">먼저 가릴 응급</span> ${sm.emergency.map(esc).join(" · ")}</p>` : "") +
    (sm.common?.length ? `<p><span class="tag">흔한 원인</span> ${sm.common.map(esc).join(" · ")}</p>` : "") +
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
      c.rows.map((r) => `<tr><th>${esc(r.dx)}</th>${r.cells.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("") +
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

// 결과 창 복습 링크 → 공부 탭 위치. 앞에 있는 것부터 찾아 처음 있는 곳으로 간다.
const SECTION_TARGETS = {
  hpi: ["st-cat-B", "st-flow"],
  redflag: ["st-cat-D", "st-summary"],
  pmh: ["st-cat-E", "st-flow"],
  flow: ["st-script", "st-flow"],
};

export function initStudyTab({ onStartInterview, canInterview } = {}) {
  const select = $("stTopic");
  const body = $("stBody");
  const startBtn = $("stStart");
  if (!select || !body) return { refresh() {} };
  let indexReady = null; // 목록은 한 번만 받는다. 결과 창에서 바로 열 때도 목록이 다 찬 뒤에 고르도록 promise 를 나눠 쓴다.
  let current = null;

  function loadIndex() {
    indexReady ||= fetchIndex();
    return indexReady;
  }
  async function fetchIndex() {
    try {
      const res = await fetch("study/index.json", { cache: "no-cache" });
      const data = await res.json();
      for (const t of data.topics || []) {
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
    startBtn?.classList.add("hidden");
    if (!key) {
      body.innerHTML = `<p class="hint">주제를 고르면 감별 진단과 진단마다 핵심 단서, 채점표가 나옵니다.</p>`;
      return;
    }
    body.innerHTML = `<p class="hint">불러오는 중…</p>`;
    try {
      const res = await fetch(`study/${encodeURIComponent(key)}.json`, { cache: "no-cache" });
      const d = await res.json();
      if (select.value !== key) return; // 그새 다른 주제를 골랐다
      current = d;
      // 가이드가 있으면 질문 흐름과 비교표가 중심이고, 진단별 카드는 "자세히", 채점표는 접어 둔다.
      // 가이드가 아직 없는 주제는 감별 목록과 진단별 카드가 중심이다.
      const dxList = `<ol class="study-dx">${d.scenarios.map((s) => `<li>${esc(s.dx)}</li>`).join("")}</ol>`;
      body.innerHTML =
        (d.guide
          ? guideHtml(d.guide)
          : `<h3>감별 진단 ${d.scenarios.length}가지</h3>${dxList}<p class="hint">면담에서는 이 가운데 하나가 무작위로 나옵니다. 이 주제의 면담 흐름 가이드는 준비 중입니다.</p>`) +
        `<h3>진단별 단서 비교</h3><p class="hint">면담에서 환자가 실제로 말하는 내용과 진찰 소견입니다. 표가 넓으면 옆으로 밀어 보세요.</p>` +
        matrixHtml(d.scenarios) +
        `<h3>진단별 문답</h3><p class="hint">진단마다 꼭 물어야 하는 질문과 환자의 답입니다.</p>` +
        d.scenarios.map(scenarioCard).join("") +
        `<details class="study-card study-rubric"><summary>채점 기준 보기${d.commonChecklist ? " (공통)" : ""}</summary>` +
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
  body.addEventListener("click", (e) => {
    const li = e.target.closest(".script.hide-hints .script-qs li.has-note");
    if (li) li.classList.toggle("revealed");
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
