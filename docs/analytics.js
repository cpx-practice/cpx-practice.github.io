// 분석 탭 — 기록 배열 하나만 받아서 요약·추이·영역별·커버리지를 그린다.
// Firestore 를 직접 만지지 않는다 (app.js 가 넘겨준 rows 로만 계산).
//
// 색은 SVG 안에서도 CSS 변수를 그대로 쓴다. 다크모드로 바뀌어도 다시 그릴 필요 없이
// 브라우저가 알아서 새 값으로 칠한다.

import { TOPICS, matchTopic } from "./topics.js";

const MAX = { history: 60, pe: 20, ppi: 20 };

const el = (id) => document.getElementById(id);
const esc = (s) => {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
};

// 점수(백분율) → 4단계 밴드. 커버리지 칩과 영역 막대가 같은 기준을 쓴다.
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
  // rows 는 최신순이므로 추이는 뒤집어 시간순으로 본다.
  const chrono = [...scored].reverse();

  const totals = chrono.map((r) => r.totalScore);
  const overall = avg(totals);

  // 최근 5회와 그 이전을 견줘 방향만 본다. 이전 기록이 없으면 추세도 없다.
  const recentN = Math.min(5, chrono.length);
  const recent = avg(totals.slice(-recentN));
  const prior = chrono.length > recentN ? avg(totals.slice(0, -recentN)) : null;

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
    });
  }

  const coverage = TOPICS.map((t) => {
    const e = byTopic.get(t.name);
    if (!e) {
      return { topic: t, count: 0, mean: null, best: null, latest: null, last: 0, attempts: [], sect: {} };
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
    overall,
    recent,
    prior,
    recentN,
    sections,
    coverage,
    doneCount,
    unmatched: [...unmatched],
    trend: chrono.map((r) => ({
      total: r.totalScore,
      history: r.historyScore,
      pe: r.peScore,
      ppi: r.ppiScore,
      topic: r.topic || "무작위",
      at: r.createdAt?.toDate ? r.createdAt.toDate() : null,
    })),
  };
}

// 다음에 뭘 연습할지 — 안 해본 것 먼저, 그다음 평균이 낮은 것.
function recommend(stats) {
  const out = [];
  const undone = stats.coverage.filter((c) => c.count === 0);
  if (undone.length) {
    // 연습이 쌓일수록 추천이 돌아가도록 기록 수를 오프셋으로 쓴다.
    const start = stats.scoredCount % undone.length;
    for (let i = 0; i < Math.min(2, undone.length); i++) {
      out.push({ name: undone[(start + i) % undone.length].topic.name, why: "아직 해보지 않은 케이스" });
    }
  }
  const weak = stats.coverage
    .filter((c) => c.count > 0 && c.mean !== null)
    .sort((a, b) => a.mean - b.mean)
    .slice(0, Math.max(0, 3 - out.length));
  for (const c of weak) {
    out.push({ name: c.topic.name, why: `평균 ${round1(c.mean)}점 · ${c.count}회` });
  }
  return out.slice(0, 3);
}

// ---------- 그리기 ----------

let lastStats = null;
let wired = false;

// 정렬 드롭다운은 한 번만 채우고 한 번만 묶는다.
function wireOnce() {
  if (wired) return;
  wired = true;
  const sel = el("caseSort");
  sel.innerHTML = Object.entries(CASE_SORTS)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join("");
  sel.value = "weak";
  sel.addEventListener("change", () => {
    if (lastStats) renderCases(lastStats);
  });
}

export function renderAnalytics(rows) {
  wireOnce();
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

  renderTiles(stats);
  renderTrend(stats);
  renderSections(stats);
  renderCases(stats);
  renderCoverage(stats);
  renderRecommend(stats);
}

function renderTiles(s) {
  const delta = s.prior === null || s.recent === null ? null : round1(s.recent - s.prior);
  const arrow = delta === null ? "" : delta > 0 ? "▲" : delta < 0 ? "▼" : "―";
  const dir = delta === null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const deltaText =
    delta === null ? "비교할 이전 기록 없음" : `${arrow} 이전 대비 ${Math.abs(delta)}점`;

  el("tiles").innerHTML = [
    `<div class="tile">
       <span class="tile-label">평균 총점</span>
       <span class="tile-value">${s.overall === null ? "-" : round1(s.overall)}</span>
       <span class="tile-sub">채점된 ${s.scoredCount}회 기준</span>
     </div>`,
    `<div class="tile">
       <span class="tile-label">최근 ${s.recentN}회 평균</span>
       <span class="tile-value">${s.recent === null ? "-" : round1(s.recent)}</span>
       <span class="tile-sub ${dir}">${deltaText}</span>
     </div>`,
    `<div class="tile">
       <span class="tile-label">케이스 커버리지</span>
       <span class="tile-value">${s.doneCount}<span class="tile-unit"> / ${s.coverage.length}</span></span>
       <span class="tile-sub">남은 케이스 ${s.coverage.length - s.doneCount}개</span>
     </div>`,
  ].join("");
}

// --- 총점 추이 (선 그래프 + 크로스헤어 툴팁) ---

let trendState = null;

function renderTrend(s) {
  const host = el("trendChart");
  const pts = s.trend;

  if (pts.length < 2) {
    host.innerHTML = '<p class="muted small">연습이 2회 이상 쌓이면 추이가 그려집니다.</p>';
    trendState = null;
    return;
  }

  // 글자를 또렷하게 두려고 컨테이너 너비에 1:1 픽셀로 그린다 (viewBox 확대 안 함).
  const W = Math.max(280, host.clientWidth || 640);
  const H = 220;
  const pad = { t: 14, r: 14, b: 26, l: 34 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const lo = Math.max(0, Math.floor((Math.min(...pts.map((p) => p.total)) - 6) / 10) * 10);
  const hi = 100;
  const x = (i) => pad.l + (i / (pts.length - 1)) * iw;
  const y = (v) => pad.t + ih - ((v - lo) / (hi - lo)) * ih;

  const step = hi - lo <= 40 ? 10 : 20;
  const ticks = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);

  const grid = ticks
    .map((v) => {
      const gy = y(v).toFixed(1);
      return (
        `<line class="viz-grid" x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}"/>` +
        `<text class="viz-tick" x="${pad.l - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${v}</text>`
      );
    })
    .join("");

  const path = pts
    .map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`)
    .join("");

  const mean = s.overall;
  const meanLine =
    mean === null
      ? ""
      : `<line class="viz-ref" x1="${pad.l}" y1="${y(mean).toFixed(1)}" x2="${W - pad.r}" y2="${y(mean).toFixed(1)}"/>` +
        `<text class="viz-ref-label" x="${W - pad.r}" y="${(y(mean) - 6).toFixed(1)}" text-anchor="end">평균 ${round1(mean)}</text>`;

  // 점이 빽빽하면 마커를 생략한다 — 호버할 때만 띄운다.
  const dots =
    pts.length <= 25
      ? pts
          .map((p, i) => `<circle class="viz-dot" cx="${x(i).toFixed(1)}" cy="${y(p.total).toFixed(1)}" r="4"/>`)
          .join("")
      : "";

  // 축에는 첫 회차와 마지막 회차 날짜만 붙인다.
  const dstr = (d) => (d ? `${d.getMonth() + 1}/${d.getDate()}` : "");
  const axis =
    `<text class="viz-tick" x="${pad.l}" y="${H - 8}" text-anchor="start">${dstr(pts[0].at)}</text>` +
    `<text class="viz-tick" x="${W - pad.r}" y="${H - 8}" text-anchor="end">${dstr(pts[pts.length - 1].at)}</text>`;

  host.innerHTML =
    `<svg class="viz" width="${W}" height="${H}" role="img" aria-label="총점 추이 ${pts.length}회">` +
    grid +
    meanLine +
    `<path class="viz-line" d="${path}"/>` +
    dots +
    `<line class="viz-cross hidden" y1="${pad.t}" y2="${pad.t + ih}"/>` +
    `<circle class="viz-hot hidden" r="5.5"/>` +
    axis +
    `</svg><div class="viz-tip hidden"></div>`;

  trendState = { host, pts, x, y, W };
  attachTrendHover();
}

function attachTrendHover() {
  const st = trendState;
  if (!st) return;
  const svg = st.host.querySelector("svg");
  const cross = st.host.querySelector(".viz-cross");
  const hot = st.host.querySelector(".viz-hot");
  const tip = st.host.querySelector(".viz-tip");

  const move = (clientX) => {
    const box = svg.getBoundingClientRect();
    const px = clientX - box.left;
    // 가장 가까운 회차를 고른다 — 히트 영역이 마커보다 훨씬 넓다.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < st.pts.length; i++) {
      const d = Math.abs(st.x(i) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const p = st.pts[best];
    const cx = st.x(best);
    const cy = st.y(p.total);

    cross.setAttribute("x1", cx.toFixed(1));
    cross.setAttribute("x2", cx.toFixed(1));
    hot.setAttribute("cx", cx.toFixed(1));
    hot.setAttribute("cy", cy.toFixed(1));
    cross.classList.remove("hidden");
    hot.classList.remove("hidden");

    const num = (v) => (typeof v === "number" ? v : "-");
    const date = p.at
      ? `${p.at.getFullYear()}-${pad2(p.at.getMonth() + 1)}-${pad2(p.at.getDate())}`
      : "";
    tip.innerHTML =
      `<span class="viz-tip-head">${esc(p.topic)}<span class="viz-tip-date">${date}</span></span>` +
      `<span class="viz-tip-total">총점 ${p.total}</span>` +
      `<span class="viz-tip-row">병력 ${num(p.history)} · 진찰 ${num(p.pe)} · PPI ${num(p.ppi)}</span>`;
    tip.classList.remove("hidden");

    // 오른쪽 끝에서는 툴팁을 선 왼쪽으로 접는다.
    let left = cx + 12;
    if (left + tip.offsetWidth > st.W) left = cx - tip.offsetWidth - 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, cy - 14)}px`;
  };

  const leave = () => {
    cross.classList.add("hidden");
    hot.classList.add("hidden");
    tip.classList.add("hidden");
  };

  svg.addEventListener("mousemove", (e) => move(e.clientX));
  svg.addEventListener("mouseleave", leave);
  svg.addEventListener("touchstart", (e) => move(e.touches[0].clientX), { passive: true });
  svg.addEventListener("touchmove", (e) => move(e.touches[0].clientX), { passive: true });
  svg.addEventListener("touchend", leave);
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
// 해본 케이스만 한 줄씩. 줄을 누르면 그 케이스의 회차별 점수가 펼쳐진다.

const CASE_SORTS = {
  weak: { label: "평균 낮은순", fn: (a, b) => a.mean - b.mean },
  strong: { label: "평균 높은순", fn: (a, b) => b.mean - a.mean },
  most: { label: "많이 해본순", fn: (a, b) => b.count - a.count || a.mean - b.mean },
  recent: { label: "최근 연습순", fn: (a, b) => b.last - a.last },
  bank: { label: "케이스 순서", fn: null }, // coverage 배열 순서가 곧 뱅크 순서
};

// 펼쳐둔 케이스는 다시 그려도 그대로 열려 있게 이름으로 기억한다.
const openCases = new Set();

function renderCases(s) {
  const done = s.coverage.filter((c) => c.count > 0);
  el("caseEmpty").classList.toggle("hidden", done.length > 0);
  el("caseTableWrap").classList.toggle("hidden", done.length === 0);
  el("caseSort").classList.toggle("hidden", done.length === 0);
  if (!done.length) return;

  const sort = CASE_SORTS[el("caseSort").value] || CASE_SORTS.weak;
  const rows = sort.fn ? [...done].sort(sort.fn) : done;

  const n = (v) => (typeof v === "number" ? round1(v) : "-");
  const body = el("caseBody");
  body.innerHTML = "";

  for (const c of rows) {
    const open = openCases.has(c.topic.name);
    const tr = document.createElement("tr");
    tr.className = "case-row" + (open ? " open" : "");
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    tr.setAttribute("aria-expanded", String(open));
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
      `<td colspan="8"><ol class="attempts">` +
      c.attempts
        .map((a) => {
          const d = a.date
            ? `${a.date.getFullYear()}-${pad2(a.date.getMonth() + 1)}-${pad2(a.date.getDate())}`
            : "날짜 없음";
          return (
            `<li><span class="att-date">${d}</span>` +
            `<span class="att-total">${a.total}</span>` +
            `<span class="att-sect">병력 ${n(a.history)} · 진찰 ${n(a.pe)} · PPI ${n(a.ppi)}</span></li>`
          );
        })
        .join("") +
      `</ol></td>`;

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
}

// --- 케이스 커버리지 ---

function renderCoverage(s) {
  el("coverDone").textContent = s.doneCount;
  el("coverTotal").textContent = s.coverage.length;

  el("coverGrid").innerHTML = s.coverage
    .map((c) => {
      const name = esc(c.topic.name);
      if (c.count === 0) {
        return `<span class="chip undone" title="아직 해보지 않음">${name}</span>`;
      }
      const m = round1(c.mean);
      const title = `${c.topic.name} · ${c.count}회 · 평균 ${m}점 · 최고 ${c.best}점`;
      return (
        `<span class="chip done b${band(c.mean)}" title="${esc(title)}">` +
        `<span class="chip-name">${name}</span>` +
        `<span class="chip-score">${m}${c.count > 1 ? `<span class="chip-n">×${c.count}</span>` : ""}</span>` +
        `<span class="chip-meter"><span style="width:${Math.max(2, Math.min(100, c.mean))}%"></span></span>` +
        `</span>`
      );
    })
    .join("");

  const un = el("coverUnmatched");
  un.classList.toggle("hidden", s.unmatched.length === 0);
  if (s.unmatched.length) {
    un.textContent = `케이스 뱅크에서 이름을 찾지 못한 기록: ${s.unmatched.join(", ")}`;
  }
}

function renderRecommend(s) {
  const list = recommend(s);
  el("recoList").innerHTML = list.length
    ? list
        .map((r) => `<li><code>/cpx:start ${esc(r.name)}</code><span class="reco-why">${esc(r.why)}</span></li>`)
        .join("")
    : '<li class="muted">추천할 케이스가 없습니다.</li>';
}

// 창 너비가 바뀌면 선 그래프만 다시 그린다 (1:1 픽셀로 그리기 때문에 늘려 쓸 수 없다).
let resizeTimer = null;
export function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (trendState && lastStats) renderTrend(lastStats);
  }, 150);
}
