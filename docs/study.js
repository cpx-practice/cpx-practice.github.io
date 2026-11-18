// 공부 탭 — 주제별 감별 진단, 진단마다 핵심 단서, 채점표를 보여 준다.
// 자료는 scripts/build-study.mjs 가 플러그인 카드와 채점표에서 미리 만든 docs/study/*.json 이다(면담 서버를 쓰지 않는다).
import { escapeHtml, renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => escapeHtml(String(s ?? ""));

// 채점표는 scripts/build-study.mjs 가 학생용으로 손질해 둔 것이다(채점자용 설명·시나리오 ID 제거).
const studentChecklist = (md) => String(md || "");

function list(items, cls = "") {
  if (!items || !items.length) return "";
  return `<ul class="${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
}
function rows(items) {
  if (!items || !items.length) return "";
  return `<dl class="study-dl">${items.map((x) => `<dt>${esc(x.label)}</dt><dd>${esc(x.text)}</dd>`).join("")}</dl>`;
}
function section(title, body) {
  return body ? `<h4>${esc(title)}</h4>${body}` : "";
}

function scenarioCard(s, i) {
  const flags = s.flags && s.flags.length
    ? `<ul class="study-flags">${s.flags.map((f) => `<li><span class="q">${esc(f.q)}</span> → ${esc(f.a)}</li>`).join("")}</ul>`
    : "";
  const body = [
    `<p class="hint">${esc(s.who)} · 첫마디 “${esc(s.opening)}”</p>`,
    section("현병력", rows(s.hpi)),
    section("있는 동반 증상", list(s.positive, "study-pos")),
    section("없는 증상 (감별에 쓰는 음성 소견)", list(s.negative, "study-neg")),
    section("놓치면 안 되는 질문", flags),
    section("과거력·약·가족력", rows(s.history)),
    section("활력징후", list(s.vitals)),
    section("이상 진찰 소견", rows(s.pe)),
  ].join("");
  return `<details class="study-card"${i === 0 ? "" : ""}><summary><b>${esc(s.dx)}</b></summary>${body}</details>`;
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
  const flow = (g.flow || [])
    .map(
      (f, i) =>
        `<li class="guide-step">` +
        `<div class="guide-step-head"><span class="guide-num">${i + 1}</span><b>${esc(f.step)}</b></div>` +
        (f.ask || []).map((q) => `<p class="guide-ask">“${esc(q)}”</p>`).join("") +
        (f.why ? `<p class="hint">${esc(f.why)}</p>` : "") +
        ((f.sorts || []).length
          ? `<ul class="guide-sorts">${f.sorts.map((s) => `<li><span>${esc(s.if)}</span><span class="arrow">→</span><b>${esc(s.then)}</b></li>`).join("")}</ul>`
          : "") +
        `</li>`
    )
    .join("");
  const c = g.compare;
  const compare = c && c.rows?.length
    ? `<div class="table-wrap"><table class="guide-compare"><thead><tr><th>진단</th>${c.cols.map((x) => `<th>${esc(x)}</th>`).join("")}</tr></thead><tbody>` +
      c.rows.map((r) => `<tr><th>${esc(r.dx)}</th>${r.cells.map((x) => `<td>${esc(x)}</td>`).join("")}</tr>`).join("") +
      `</tbody></table></div>`
    : "";
  const pit = (g.pitfalls || []).length ? `<ul class="guide-pitfalls">${g.pitfalls.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
  return (
    `<h3>한눈에 보기</h3>${summary}` +
    (flow ? `<h3>면담 흐름</h3><p class="hint">위에서 아래 순서로 묻습니다. 답에 따라 오른쪽 진단 쪽으로 좁혀집니다.</p><ol class="guide-flow">${flow}</ol>` : "") +
    (compare ? `<h3>감별 비교표</h3>${compare}` : "") +
    (pit ? `<h3>놓치기 쉬운 것</h3>${pit}` : "")
  );
}

export function initStudyTab({ onStartInterview, canInterview } = {}) {
  const select = $("stTopic");
  const body = $("stBody");
  const startBtn = $("stStart");
  if (!select || !body) return { refresh() {} };
  let loaded = false;
  let current = null;

  async function loadIndex() {
    if (loaded) return;
    loaded = true;
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
      loaded = false;
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
          ? guideHtml(d.guide) + `<h3>진단별 자세히</h3><p class="hint">면담에서는 이 ${d.scenarios.length}가지 중 하나가 무작위로 나옵니다. 진단마다 환자가 실제로 하는 말과 소견입니다.</p>`
          : `<h3>감별 진단 ${d.scenarios.length}가지</h3>${dxList}<p class="hint">면담에서는 이 가운데 하나가 무작위로 나옵니다. 아래에서 진단마다 펼쳐 보세요. 이 주제의 면담 흐름 가이드는 준비 중입니다.</p>`) +
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
  startBtn?.addEventListener("click", () => {
    if (current && onStartInterview) onStartInterview(current.name);
  });

  return {
    // 탭을 열 때 부른다 — 목록은 처음 한 번만 받는다.
    refresh() {
      loadIndex();
      if (!select.value) show("");
    },
  };
}
