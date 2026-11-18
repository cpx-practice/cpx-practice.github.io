// 공부 탭 — 주제별 감별 진단, 진단마다 핵심 단서, 채점표를 보여 준다.
// 자료는 scripts/build-study.mjs 가 플러그인 카드와 채점표에서 미리 만든 docs/study/*.json 이다(면담 서버를 쓰지 않는다).
import { escapeHtml, renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => escapeHtml(String(s ?? ""));

// 채점표는 채점자를 위한 설명(공통 배점표와 바꿔 쓰는 칸 등)으로 시작한다. 학생이 볼 것은 첫 "## " 제목부터다.
function studentChecklist(md) {
  const text = String(md || "").replace(/\r\n?/g, "\n");
  const start = text.search(/^## /m);
  return (start >= 0 ? text.slice(start) : text).replace(/^(\s*)- \[[ xX]\] /gm, "$1- ");
}

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
      body.innerHTML =
        `<h3>감별 진단 ${d.scenarios.length}가지</h3>` +
        `<ol class="study-dx">${d.scenarios.map((s) => `<li>${esc(s.dx)}</li>`).join("")}</ol>` +
        `<p class="hint">면담에서는 이 가운데 하나가 무작위로 나옵니다. 아래에서 진단마다 펼쳐 보세요.</p>` +
        d.scenarios.map(scenarioCard).join("") +
        `<h3>채점표${d.commonChecklist ? " (공통)" : ""}</h3>` +
        `<p class="hint">면담 뒤 평가는 이 표로 채점합니다. 물어야 할 것과 순서를 미리 익혀 두세요.</p>` +
        `<div class="study-checklist md">${renderMarkdown(studentChecklist(d.checklist))}</div>`;
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
