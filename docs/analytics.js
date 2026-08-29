// 분석 탭 — 기록 배열 하나만 받아서 영역별 성취율과 케이스별 점수를 그린다.
// Firestore 를 직접 만지지 않는다 (app.js 가 넘겨준 rows 로만 계산).

import { TOPICS, matchTopic, normalizeTopic } from "./topics.js";

const MAX = { history: 60, pe: 20, ppi: 20 };

const el = (id) => document.getElementById(id);
const esc = (s) => {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
};

// 점수(백분율) → 4단계 밴드. 케이스 막대와 영역 막대가 같은 기준을 쓴다.
function band(pct) {
  if (pct >= 90) return 4;
  if (pct >= 80) return 3;
  if (pct >= 70) return 2;
  return 1;
}

const round1 = (n) => Math.round(n * 10) / 10;
const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
const pad2 = (n) => String(n).padStart(2, "0");

// ---------- 집계 ----------

export function computeStats(rows) {
  // 채점된 기록만 통계에 넣는다. 수동 입력은 점수가 비어 있을 수 있다.
  const scored = rows.filter((r) => typeof r.totalScore === "number");

  const sections = [
    { key: "historyScore", label: "병력청취", max: MAX.history },
    { key: "peScore", label: "신체진찰", max: MAX.pe },
    { key: "ppiScore", label: "PPI", max: MAX.ppi },
  ].map((s) => {
    const vals = scored.map((r) => r[s.key]).filter((v) => typeof v === "number");
    const mean = avg(vals);
    return { ...s, mean, pct: mean === null ? null : (mean / s.max) * 100, n: vals.length };
  });

  // 주제별 — 케이스 뱅크에 이름이 맞는 기록만 센다.
  const byTopic = new Map();
  const unmatched = new Set();
  for (const r of scored) {
    const t = matchTopic(r.topic);
    if (!t) {
      if (r.topic) unmatched.add(r.topic);
      continue;
    }
    if (!byTopic.has(t.name)) byTopic.set(t.name, { attempts: [] });
    // scored 는 rows(최신순)를 그대로 거른 것이라 attempts 도 최신순으로 쌓인다.
    byTopic.get(t.name).attempts.push({
      total: r.totalScore,
      history: r.historyScore,
      pe: r.peScore,
      ppi: r.ppiScore,
      at: r.createdAt?.seconds || 0,
      date: r.createdAt?.toDate ? r.createdAt.toDate() : null,
      // 채점 결과·문진 전사를 그대로 띄우려면 원본 기록이 필요하다.
      // app.js 의 기록 상세 모달에 이 객체를 그대로 넘긴다.
      rec: r,
    });
  }

  const coverage = TOPICS.map((t) => {
    const e = byTopic.get(t.name);
    if (!e) {
      return {
        topic: t, count: 0, mean: null, best: null, latest: null, last: 0,
        attempts: [], sect: {},
      };
    }
    const scores = e.attempts.map((a) => a.total);
    const sect = {};
    for (const k of ["history", "pe", "ppi"]) {
      sect[k] = avg(e.attempts.map((a) => a[k]).filter((v) => typeof v === "number"));
    }
    return {
      topic: t,
      count: scores.length,
      mean: avg(scores),
      best: Math.max(...scores),
      latest: e.attempts[0].total, // 가장 최근 회차의 총점
      last: Math.max(...e.attempts.map((a) => a.at)),
      attempts: e.attempts,
      sect,
    };
  });

  const doneCount = coverage.filter((c) => c.count > 0).length;

  return {
    count: rows.length,
    scoredCount: scored.length,
    sections,
    coverage,
    doneCount,
    unmatched: [...unmatched],
  };
}

// ---------- 그리기 ----------

let lastStats = null;
let wired = false;
// 기록 상세 모달과 삭제는 app.js 가 갖고 있다. 분석 탭에서도 같은 것을 쓰려고 넘겨받는다.
let openRecord = null;
let removeRecord = null;

// 정렬 드롭다운은 한 번만 채우고 한 번만 묶는다.
function wireOnce() {
  if (wired) return;
  wired = true;
  const sel = el("caseSort");
  sel.innerHTML = Object.entries(CASE_SORTS)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join("");
  sel.value = "weak";

  // 검색창 아래에 뜨는 선택지. 케이스 목록은 고정이라 한 번만 채우면 된다.
  el("caseNames").innerHTML = TOPICS.map((t) => `<option value="${esc(t.name)}"></option>`).join("");

  const redraw = () => {
    if (lastStats) renderCases(lastStats);
  };
  sel.addEventListener("change", redraw);
  el("caseScope").addEventListener("change", redraw);
  el("caseQuery").addEventListener("input", redraw);
  el("caseReset").addEventListener("click", () => {
    el("caseQuery").value = "";
    el("caseScope").value = "all";
    sel.value = "weak";
    redraw();
  });
}

export function renderAnalytics(rows, opts = {}) {
  wireOnce();
  if (opts.onOpenRecord) openRecord = opts.onOpenRecord;
  if (opts.onDeleteRecord) removeRecord = opts.onDeleteRecord;
  const stats = computeStats(rows);
  lastStats = stats;

  const empty = el("analysisEmpty");
  const body = el("analysisBody");

  if (stats.scoredCount === 0) {
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.classList.remove("hidden");

  renderSections(stats);
  renderCases(stats);
}

// --- 영역별 성취율 ---

function renderSections(s) {
  const rated = s.sections.filter((x) => x.pct !== null);
  const weakest = rated.length ? rated.reduce((a, b) => (a.pct <= b.pct ? a : b)) : null;
  const showWeak = weakest && rated.length > 1;

  el("sectionBars").innerHTML = s.sections
    .map((x) => {
      if (x.pct === null) {
        return (
          '<div class="sbar"><span class="sbar-label">' +
          x.label +
          '</span><span class="sbar-track"></span><span class="sbar-val muted">기록 없음</span></div>'
        );
      }
      const isWeak = showWeak && x.label === weakest.label;
      return (
        `<div class="sbar${isWeak ? " weak" : ""}">` +
        `<span class="sbar-label">${x.label}${isWeak ? '<span class="tag">약점</span>' : ""}</span>` +
        `<span class="sbar-track"><span class="sbar-fill b${band(x.pct)}" style="width:${x.pct.toFixed(1)}%"></span></span>` +
        `<span class="sbar-val">${round1(x.mean)} / ${x.max}<span class="sbar-pct">${Math.round(x.pct)}%</span></span>` +
        `</div>`
      );
    })
    .join("");

  el("sectionNote").textContent = showWeak
    ? `배점 대비 성취율이 가장 낮은 영역은 ${weakest.label}입니다 (${Math.round(weakest.pct)}%).`
    : "";
}


// --- 케이스별 점수 ---
// 케이스 뱅크 58개를 전부 한 줄씩 낸다. 해본 케이스는 누르면 회차별 점수가 펼쳐지고,
// 회차마다 그때의 채점 결과·문진 전사를 볼 수 있다. 안 해본 케이스는 흐리게 한 줄로만 남는다.

const CASE_SORTS = {
  weak: { label: "평균 낮은순", fn: (a, b) => a.mean - b.mean },
  strong: { label: "평균 높은순", fn: (a, b) => b.mean - a.mean },
  most: { label: "많이 해본순", fn: (a, b) => b.count - a.count || a.mean - b.mean },
  recent: { label: "최근 연습순", fn: (a, b) => b.last - a.last },
  bank: { label: "케이스 순서", fn: null }, // coverage 배열 순서가 곧 뱅크 순서
};

// 펼쳐둔 케이스는 다시 그려도 그대로 열려 있게 이름으로 기억한다.
const openCases = new Set();

// 회차에 볼 만한 본문이 있는지. 본문 자체는 recordDetails/{id} 에 따로 있고 열 때만 가져오므로,
// 여기서는 기록에 남은 가벼운 표시만 본다. 2026-08-29 이전 기록은 본문이 문서 안에 그대로 있다.
function hasDetail(r) {
  return Boolean(
    r?.hasEvaluation ||
      r?.hasTranscript ||
      r?.evaluationChunks?.length ||
      r?.transcriptChunks?.length ||
      r?.evaluationText ||
      r?.transcript
  );
}

// 검색·범위·정렬을 적용한 목록. 미실시는 점수가 없어 정렬 대상이 아니므로,
// 케이스 순서로 볼 때가 아니면 해본 것 뒤에 뱅크 순서 그대로 붙인다.
function filterCases(s) {
  const q = normalizeTopic(el("caseQuery").value);
  const scope = el("caseScope").value;
  const sortKey = el("caseSort").value;

  let list = s.coverage;
  if (q) list = list.filter((c) => normalizeTopic(c.topic.name).includes(q));
  if (scope === "done") list = list.filter((c) => c.count > 0);
  if (scope === "undone") list = list.filter((c) => c.count === 0);

  const sort = CASE_SORTS[sortKey] || CASE_SORTS.weak;
  if (!sort.fn) return list;
  const done = list.filter((c) => c.count > 0).sort(sort.fn);
  const undone = list.filter((c) => c.count === 0);
  return [...done, ...undone];
}

// 이 케이스의 성적 추이. 회차가 보통 한 자릿수라 그래프 대신 회차별 막대로 낸다.
// 막대 길이가 점수이고 순서는 오래된 것부터라, 두 회차만 있어도 방향이 읽힌다.
function trendPane(c) {
  // attempts 는 최신순이므로 시간순으로 뒤집는다.
  const chrono = [...c.attempts].reverse();
  const first = chrono[0];
  const last = chrono[chrono.length - 1];
  const delta = last.total - first.total;

  const head =
    chrono.length < 2
      ? `<p class="tr-once">아직 1회뿐입니다. 다시 풀면 여기에 변화가 보입니다.</p>`
      : `<p class="tr-delta ${delta > 0 ? "up" : delta < 0 ? "down" : "flat"}">` +
        `<span class="tr-arrow">${delta > 0 ? "▲" : delta < 0 ? "▼" : "―"}</span>` +
        `<span class="tr-amount">${delta > 0 ? "+" : ""}${delta}점</span>` +
        `<span class="tr-span">첫 회 ${first.total} → 최근 ${last.total}</span></p>`;

  const bars = chrono
    .map((a, i) => {
      const d = a.date ? `${a.date.getMonth() + 1}/${a.date.getDate()}` : "";
      return (
        `<li>` +
        `<span class="tr-n">${i + 1}회</span>` +
        `<span class="tr-track"><span class="tr-fill b${band(a.total)}" style="width:${Math.max(2, Math.min(100, a.total))}%"></span></span>` +
        `<span class="tr-score">${a.total}</span>` +
        `<span class="tr-date">${d}</span>` +
        `</li>`
      );
    })
    .join("");

  return (
    `<div class="case-pane"><h4>성적 추이</h4>` +
    head +
    `<ol class="tr-list">${bars}</ol>` +
    `<p class="tr-foot">최고 ${c.best} · 평균 ${round1(c.mean)}</p>` +
    `</div>`
  );
}

function renderCases(s) {
  const rows = filterCases(s);
  const filtering =
    Boolean(el("caseQuery").value.trim()) ||
    el("caseScope").value !== "all" ||
    el("caseSort").value !== "weak";
  el("caseReset").classList.toggle("hidden", !filtering);

  const empty = el("caseEmpty");
  empty.classList.toggle("hidden", rows.length > 0);
  el("caseTableWrap").classList.toggle("hidden", rows.length === 0);
  if (!rows.length) {
    // 조건이 좁혀졌으면 이전 줄이 남아 있으면 안 된다 — 감싸개만 숨기고 두면 DOM 에 유령이 남는다.
    el("caseBody").innerHTML = "";
    empty.textContent = el("caseQuery").value.trim()
      ? "그 이름의 케이스가 없습니다."
      : "보여줄 케이스가 없습니다.";
    return;
  }

  const n = (v) => (typeof v === "number" ? round1(v) : "-");
  const body = el("caseBody");
  body.innerHTML = "";

  for (const c of rows) {
    // 안 해본 케이스는 펼칠 것이 없다. 클릭도 키보드 초점도 주지 않는다.
    if (c.count === 0) {
      const tr = document.createElement("tr");
      tr.className = "case-row undone";
      tr.dataset.case = c.topic.name;
      tr.innerHTML =
        `<td data-label="케이스" class="case-name"><span class="caret"></span>${esc(c.topic.name)}` +
        `<span class="tag-undone">미실시</span></td>` +
        `<td data-label="횟수" class="num">-</td>` +
        `<td data-label="평균" class="num">-</td>` +
        `<td data-label="최고" class="num">-</td>` +
        `<td data-label="최근" class="num">-</td>` +
        `<td data-label="병력" class="num sect">-</td>` +
        `<td data-label="진찰" class="num sect">-</td>` +
        `<td data-label="PPI" class="num sect">-</td>`;
      body.appendChild(tr);
      continue;
    }

    const open = openCases.has(c.topic.name);
    const tr = document.createElement("tr");
    tr.className = "case-row" + (open ? " open" : "");
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-expanded", String(open));
    tr.dataset.case = c.topic.name;
    tr.innerHTML =
      `<td data-label="케이스" class="case-name"><span class="caret">${open ? "▾" : "▸"}</span>${esc(c.topic.name)}</td>` +
      `<td data-label="횟수" class="num">${c.count}</td>` +
      `<td data-label="평균" class="num mean">` +
      `<span class="cell-val">${n(c.mean)}</span>` +
      `<span class="cell-meter b${band(c.mean)}"><span style="width:${Math.max(2, Math.min(100, c.mean))}%"></span></span>` +
      `</td>` +
      `<td data-label="최고" class="num">${c.best}</td>` +
      `<td data-label="최근" class="num">${c.latest}</td>` +
      `<td data-label="병력" class="num sect">${n(c.sect.history)}</td>` +
      `<td data-label="진찰" class="num sect">${n(c.sect.pe)}</td>` +
      `<td data-label="PPI" class="num sect">${n(c.sect.ppi)}</td>`;

    const detail = document.createElement("tr");
    detail.className = "case-detail" + (open ? "" : " hidden");
    detail.innerHTML =
      `<td colspan="8"><div class="case-panes">` +
      `<div class="case-pane"><h4>회차별 점수</h4><ol class="attempts">` +
      c.attempts
        .map((a, i) => {
          const d = a.date
            ? `${a.date.getFullYear()}-${pad2(a.date.getMonth() + 1)}-${pad2(a.date.getDate())}`
            : "날짜 없음";
          return (
            `<li><span class="att-date">${d}</span>` +
            `<span class="att-total">${a.total}</span>` +
            `<span class="att-sect">병력 ${n(a.history)} · 진찰 ${n(a.pe)} · PPI ${n(a.ppi)}</span>` +
            (hasDetail(a.rec)
              ? `<button type="button" class="btn ghost small js-open" data-i="${i}">면담 보기</button>`
              : `<span class="att-none">저장된 내용 없음</span>`) +
            `<button type="button" class="btn ghost small js-del" data-i="${i}">삭제</button>` +
            `</li>`
          );
        })
        .join("") +
      `</ol></div>` +
      trendPane(c) +
      `</div></td>`;

    // 회차의 채점 결과 / 문진 전사는 기록 탭과 같은 모달로 띄운다.
    detail.querySelectorAll(".js-open").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (openRecord) openRecord(c.attempts[Number(b.dataset.i)].rec);
      });
    });

    // 기록이 쌓이면 목록에서 하나씩 찾아 지우기가 번거롭다. 여기서 바로 지울 수 있게 한다.
    // 지우면 구독이 다시 그리므로 화면 갱신은 따로 하지 않는다.
    detail.querySelectorAll(".js-del").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!removeRecord) return;
        const a = c.attempts[Number(b.dataset.i)];
        const when = a.date
          ? `${a.date.getFullYear()}-${pad2(a.date.getMonth() + 1)}-${pad2(a.date.getDate())}`
          : "날짜 없음";
        removeRecord(a.rec.id, `${c.topic.name} · ${when} · ${a.total}점`);
      });
    });

    const toggle = () => {
      const nowOpen = !openCases.has(c.topic.name);
      if (nowOpen) openCases.add(c.topic.name);
      else openCases.delete(c.topic.name);
      tr.classList.toggle("open", nowOpen);
      tr.setAttribute("aria-expanded", String(nowOpen));
      tr.querySelector(".caret").textContent = nowOpen ? "▾" : "▸";
      detail.classList.toggle("hidden", !nowOpen);
    };
    tr.addEventListener("click", toggle);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });

    body.appendChild(tr);
    body.appendChild(detail);
  }

  const un = el("coverUnmatched");
  un.classList.toggle("hidden", s.unmatched.length === 0);
  if (s.unmatched.length) {
    un.textContent = `케이스 뱅크에서 이름을 찾지 못한 기록: ${s.unmatched.join(", ")}`;
  }
}
