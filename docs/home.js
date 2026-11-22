// 홈 탭 — 사이트를 열면 처음 보는 요약 화면.
// 면담 바로 시작, 시험 D-day, 주제 진도, 최근 점수 추이, 다음에 할 일, 최근 기록을 한 화면에 모은다.
// 자료는 모두 이미 불러온 내 기록(getRecords)과 공부 자료 목록(study/index.json)에서 계산한다.
import { escapeHtml } from "./markdown.js";
import { matchTopic } from "./topics.js";
import { fmtDateTime } from "./export.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => escapeHtml(String(s ?? ""));
const band = (v) => (v >= 90 ? 4 : v >= 80 ? 3 : v >= 70 ? 2 : 1);
const chip = (v) => (typeof v === "number" ? `<span class="score-chip b${band(v)}">${v}</span>` : "");
const EXAM_KEY = "cpx-exam-date";

// 면담 탭의 AI 설정(interview.js CONFIG_STORAGE). 무료(키 없이)가 아니면 본인 키를 쓰는 중이다.
function usesOwnKey() {
  try {
    const c = JSON.parse(localStorage.getItem("cpx-ai-config") || "null");
    return !!(c && c.provider && c.provider !== "free");
  } catch {
    return false;
  }
}

function readExamDate() {
  try {
    return localStorage.getItem(EXAM_KEY) || "";
  } catch {
    return "";
  }
}
function writeExamDate(v) {
  try {
    if (v) localStorage.setItem(EXAM_KEY, v);
    else localStorage.removeItem(EXAM_KEY);
  } catch {
    /* 저장이 막힌 브라우저에서는 이번 화면에서만 보인다 */
  }
}

// 오늘(한국 날짜)부터 시험일까지 남은 날. 시험일이 지났으면 음수.
function daysUntil(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - today) / 86400000);
}

export function initHomeTab({ getRecords, canInterview, onStartInterview, onStudy, goto, endpoint } = {}) {
  const body = $("homeBody");
  if (!body) return { refresh() {} };
  let topics = [];
  let topicsReady = null;
  let status = null; // 워커의 오늘 무료 면담 상태
  let statusAt = 0;

  function loadTopics() {
    topicsReady ||= fetch("study/index.json", { cache: "no-cache" })
      .then((r) => r.json())
      .then((d) => (topics = d.topics || []))
      .catch(() => (topicsReady = null));
    return topicsReady;
  }

  // 오늘 무료 면담이 열려 있는지 — 5분에 한 번만 묻는다.
  async function loadStatus() {
    if (!endpoint || Date.now() - statusAt < 5 * 60 * 1000) return;
    statusAt = Date.now();
    try {
      const res = await fetch(`${endpoint}/interview/ai/status`, { method: "POST" });
      status = await res.json();
    } catch {
      status = null;
    }
  }

  function render() {
    const rows = (getRecords ? getRecords() : []).slice(); // 최신순으로 온다
    const scored = rows.filter((r) => typeof r.totalScore === "number");
    const canIv = canInterview ? canInterview() : false;

    // --- 시작 + D-day ---
    const exam = readExamDate();
    const dd = daysUntil(exam);
    const ddText = dd === null ? "" : dd > 0 ? `D-${dd}` : dd === 0 ? "D-day" : `D+${-dd}`;
    let statusText = "";
    if (status && status.enabled) {
      statusText = status.canStart
        ? "오늘 무료 면담 가능"
        : "오늘 무료 한도 소진 · 오전 9시 초기화 (내 Gemini 키로는 가능)";
    }
    const hero =
      `<div class="panel home-hero">` +
      `<div class="home-hero-main">` +
      `<h2>연습</h2>` +
      (canIv
        ? `<div class="home-actions"><button type="button" class="btn primary" data-act="start-random">무작위로 면담 시작</button>` +
          `<button type="button" class="btn ghost" data-act="goto" data-view="study">주제 보기</button></div>`
        : `<p class="hint">면담 탭이 꺼진 계정입니다. 관리자에게 문의하세요.</p>`) +
      (statusText ? `<p class="hint home-status">${esc(statusText)}</p>` : "") +
      // 무료 면담은 하루 전체 양이 정해져 있다 — 본인 키를 넣으면 그 몫과 상관없이 연습할 수 있다는 것을 늘 보이게 둔다.
      (canIv && !usesOwnKey()
        ? `<p class="hint home-ownkey">무료 면담은 하루 횟수가 정해져 있습니다. 내 Gemini 무료 키를 넣으면 횟수 걱정 없이 연습할 수 있습니다. ` +
          `<button type="button" class="btn-link" data-act="own-key">키 넣기</button></p>`
        : "") +
      `</div>` +
      `<div class="home-dday">` +
      (ddText
        ? `<div class="dday-num">${ddText}</div><div class="hint">시험일 ${esc(exam)}</div><button type="button" class="btn-link" data-act="edit-exam">바꾸기</button>`
        : `<div class="hint">시험일 미설정</div><button type="button" class="btn ghost small" data-act="edit-exam">시험일 입력</button>`) +
      `<div class="dday-edit hidden"><input type="date" id="homeExamDate" value="${esc(exam)}" aria-label="시험일" />` +
      `<button type="button" class="btn small primary" data-act="save-exam">저장</button>` +
      (exam ? `<button type="button" class="btn-link" data-act="clear-exam">지우기</button>` : "") +
      `</div></div></div>`;

    // --- 진도 ---
    const stats = new Map();
    for (const r of rows) {
      const t = matchTopic(r.topic);
      if (!t) continue;
      const cur = stats.get(t.name) || { count: 0, best: null, last: null };
      cur.count++;
      if (typeof r.totalScore === "number") {
        if (cur.best === null || r.totalScore > cur.best) cur.best = r.totalScore;
        if (cur.last === null) cur.last = r.totalScore; // rows 는 최신순 — 처음 만난 것이 가장 최근
      }
      stats.set(t.name, cur);
    }
    const total = topics.length;
    const done = topics.filter((t) => stats.get(t.name)?.count).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const progress =
      `<div class="panel home-card">` +
      `<h3>진도</h3>` +
      (total
        ? `<div class="home-big">${done}<span class="home-of"> / ${total}</span></div>` +
          `<div class="tg-bar"><span style="width:${pct}%"></span></div>` +
          `<p class="hint">${total - done ? `미연습 ${total - done}개` : "전 주제 1회 이상 연습"}</p>` +
          `<button type="button" class="btn-link" data-act="goto" data-view="study">주제 목록</button>`
        : `<p class="hint">불러오는 중…</p>`) +
      `</div>`;

    // --- 최근 점수 추이 (최근 10회, 왼쪽이 오래된 것) ---
    const recent = scored.slice(0, 10).reverse();
    const avg = (a) => (a.length ? a.reduce((s, r) => s + r.totalScore, 0) / a.length : null);
    const last5 = avg(scored.slice(0, 5));
    const prev5 = avg(scored.slice(5, 10));
    const delta = last5 !== null && prev5 !== null ? last5 - prev5 : null;
    const trend =
      `<div class="panel home-card">` +
      `<h3>점수 추이</h3>` +
      (recent.length
        ? `<div class="home-big">${last5.toFixed(0)}<span class="home-of">점 · 최근 5회 평균</span></div>` +
          (delta !== null
            ? `<p class="hint home-delta ${delta >= 0 ? "up" : "down"}">직전 5회 대비 ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}</p>`
            : "") +
          `<div class="spark" role="img" aria-label="최근 ${recent.length}회 총점">` +
          recent
            .map((r) => `<span class="spark-bar b${band(r.totalScore)}" style="height:${Math.max(4, r.totalScore)}%" title="${esc(r.topic || "")} ${r.totalScore}점"></span>`)
            .join("") +
          `</div>`
        : `<p class="hint">채점 기록 없음</p>`) +
      `</div>`;

    // --- 다음에 할 일 ---
    const todo = [];
    const lastN = scored.slice(0, 10);
    const part = (k, max) => {
      const v = lastN.filter((r) => typeof r[k] === "number");
      return v.length ? v.reduce((s, r) => s + r[k], 0) / (v.length * max) : null;
    };
    // [영역 이름(조사 포함), 점수 비율]
    const parts = [
      ["병력청취가", part("historyScore", 60)],
      ["신체진찰이", part("peScore", 20)],
      ["PPI(환자와의 소통)가", part("ppiScore", 20)],
    ].filter(([, v]) => v !== null);
    if (parts.length) {
      const [label, v] = parts.sort((a, b) => a[1] - b[1])[0];
      const name = label.slice(0, -1);
      todo.push(`<li>최약 영역 <b>${esc(name)}</b> ${Math.round(v * 100)}% <span class="hint">(최근 10회)</span></li>`);
    }
    // 최근 점수가 가장 낮은 주제(2회 이상이 아니어도 마지막 점수 기준)
    const weak = [...stats.entries()].filter(([, s]) => s.last !== null).sort((a, b) => a[1].last - b[1].last)[0];
    if (weak && weak[1].last < 80) {
      todo.push(
        `<li>최저 점수 주제 <b>${esc(weak[0])}</b> ${chip(weak[1].last)} ` +
          `<button type="button" class="btn-link" data-act="study" data-topic="${esc(weak[0])}">공부</button>` +
          (canIv ? ` · <button type="button" class="btn-link" data-act="start" data-topic="${esc(weak[0])}">다시 면담</button>` : "") +
          `</li>`
      );
    }
    const fresh = topics.filter((t) => !stats.get(t.name)?.count);
    if (fresh.length) {
      // 하루 동안은 같은 주제를 추천한다(새로고침할 때마다 바뀌면 헷갈린다).
      const day = new Date().getDate();
      const pick = fresh[day % fresh.length];
      todo.push(
        `<li>미연습 주제 <b>${esc(pick.name)}</b> ` +
          `<button type="button" class="btn-link" data-act="study" data-topic="${esc(pick.name)}">공부</button>` +
          (canIv ? ` · <button type="button" class="btn-link" data-act="start" data-topic="${esc(pick.name)}">면담</button>` : "") +
          `</li>`
      );
    }
    const next =
      `<div class="panel home-card home-wide">` +
      `<h3>추천</h3>` +
      (todo.length ? `<ul class="home-todo">${todo.join("")}</ul>` : `<p class="hint">면담 기록이 쌓이면 표시됩니다.</p>`) +
      `</div>`;

    // --- 최근 기록 ---
    const latest = rows.slice(0, 3);
    const recentList =
      `<div class="panel home-card home-wide">` +
      `<div class="panel-header"><h3>최근 기록</h3><button type="button" class="btn-link" data-act="goto" data-view="records">전체 기록</button></div>` +
      (latest.length
        ? `<ul class="home-recent">${latest
            .map((r) => `<li><span class="home-when">${esc(fmtDateTime(r.createdAt))}</span><span class="home-topic">${esc(r.topic || "무작위")}</span>${chip(r.totalScore)}</li>`)
            .join("")}</ul>`
        : `<p class="hint">기록 없음</p>`) +
      `</div>`;

    body.innerHTML = hero + `<div class="home-grid">${progress}${trend}${next}${recentList}</div>`;
  }

  body.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    if (act === "start-random") onStartInterview && onStartInterview("");
    else if (act === "start") onStartInterview && onStartInterview(el.dataset.topic);
    else if (act === "study") onStudy && onStudy(el.dataset.topic);
    else if (act === "goto") goto && goto(el.dataset.view);
    else if (act === "own-key") {
      // 면담 탭의 "AI 변경"(키 입력 화면)을 연다.
      goto && goto("interview");
      setTimeout(() => document.getElementById("btnChangeKey")?.click(), 0);
    }
    else if (act === "edit-exam") {
      body.querySelector(".dday-edit")?.classList.remove("hidden");
      $("homeExamDate")?.focus();
    } else if (act === "save-exam") {
      writeExamDate($("homeExamDate")?.value || "");
      render();
    } else if (act === "clear-exam") {
      writeExamDate("");
      render();
    }
  });

  return {
    // 탭을 열 때·기록이 바뀔 때 부른다.
    async refresh() {
      render();
      await Promise.all([loadTopics(), loadStatus()]);
      render();
    },
  };
}
