"use strict";

const PROJECT_LABELS = {
  greenpoly: "GreenPoly 独立站",
  "pet-mbti": "宠物 MBTI",
  "id-photo": "证件照小程序",
  followmate: "FollowMate 桌面版"
};

// Stable per-project colors for the compare overlay + legend.
const PROJECT_COLORS = {
  greenpoly: "#4c9aff",
  "pet-mbti": "#c576f6",
  "id-photo": "#3fb950",
  followmate: "#f0883e"
};
const FALLBACK_COLOR = "#8b98a5";

const METRIC_LABELS = { dau: "活跃人数", newUsers: "新增", events: "事件数" };

const state = {
  days: 30,
  projects: [],
  byProject: {}, // project -> { day -> {dau,newUsers,events} }
  selected: null,
  metric: "dau",
  compare: false,
  loading: false,
  error: null
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDay(key, delta) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function dayRange(days) {
  const out = [];
  let key = todayKey();
  for (let i = 0; i < days; i++) {
    out.unshift(key);
    key = shiftDay(key, -1);
  }
  return out;
}

function colorOf(project) {
  return PROJECT_COLORS[project] || FALLBACK_COLOR;
}

function setStatus(kind, message) {
  const el = document.getElementById("status");
  if (!kind) { el.hidden = true; el.className = "status"; el.textContent = ""; return; }
  el.hidden = false;
  el.className = "status " + kind;
  el.textContent = message;
}

async function load() {
  state.loading = true;
  state.error = null;
  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn) refreshBtn.disabled = true;
  if (!state.projects.length) setStatus("loading", "加载中…");
  try {
    const res = await fetch(`/api/summary?days=${state.days}`);
    if (!res.ok) throw new Error(`服务返回 ${res.status}`);
    const json = await res.json();
    if (!json || json.ok === false) throw new Error(json && json.error ? json.error : "响应无效");
    state.projects = json.projects || [];
    state.byProject = {};
    for (const p of state.projects) state.byProject[p] = {};
    for (const row of json.rows || []) {
      if (!state.byProject[row.project]) state.byProject[row.project] = {};
      state.byProject[row.project][row.day] = { dau: row.dau, newUsers: row.newUsers, events: row.events };
    }
    if (!state.selected || !state.projects.includes(state.selected)) {
      state.selected = state.projects[0] || null;
    }
    state.error = null;
    setStatus(null);
    render();
  } catch (err) {
    state.error = err.message || "加载失败";
    setStatus("error", `加载失败：${state.error} · 点「刷新」重试`);
  } finally {
    state.loading = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}
function metricAt(project, day) {
  const rec = state.byProject[project] && state.byProject[project][day];
  return rec ? rec[state.metric] : 0;
}

function seriesOf(project) {
  return dayRange(state.days).map((d) => metricAt(project, d));
}

// ─── summary cards (per project, today) ─────────────────────────────────────

function renderCards() {
  const today = todayKey();
  const yesterday = shiftDay(today, -1);
  const el = document.getElementById("cards");
  el.innerHTML = "";
  for (const p of state.projects) {
    const days = state.byProject[p] || {};
    const todayDau = (days[today] && days[today].dau) || 0;
    const yDau = (days[yesterday] && days[yesterday].dau) || 0;
    const diff = todayDau - yDau;
    const totalNew = Object.values(days).reduce((s, r) => s + r.newUsers, 0);
    const cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
    const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "—";
    const card = document.createElement("div");
    card.className = "card" + (p === state.selected ? " active" : "");
    card.innerHTML = `
      <div class="name">${PROJECT_LABELS[p] || p}</div>
      <div class="dau">${todayDau}<small>今日活跃</small></div>
      <div class="delta ${cls}">${arrow} 较昨日 ${diff >= 0 ? "+" : ""}${diff}</div>
      <div class="sub">近${state.days}天新增 ${totalNew} 人</div>`;
    card.addEventListener("click", () => { state.selected = p; render(); });
    el.appendChild(card);
  }
}

// ─── interval overview stats ────────────────────────────────────────────────

function renderStats() {
  const box = document.getElementById("stats");
  const label = METRIC_LABELS[state.metric];
  if (state.compare) {
    // Aggregate across all projects for the current metric.
    const range = dayRange(state.days);
    const perDayTotals = range.map((d) =>
      state.projects.reduce((s, p) => s + metricAt(p, d), 0));
    const total = perDayTotals.reduce((s, v) => s + v, 0);
    const peak = Math.max(0, ...perDayTotals);
    const peakIdx = perDayTotals.indexOf(peak);
    const avg = range.length ? total / range.length : 0;
    box.innerHTML = statTiles([
      ["合计" + label, total],
      ["日均", avg.toFixed(1)],
      ["峰值", peak, peakIdx >= 0 && peak > 0 ? range[peakIdx].slice(5) : ""],
      ["活跃项目", state.projects.filter((p) => seriesOf(p).some((v) => v > 0)).length]
    ]);
    return;
  }
  const p = state.selected;
  if (!p) { box.innerHTML = ""; return; }
  const values = seriesOf(p);
  const total = values.reduce((s, v) => s + v, 0);
  const peak = Math.max(0, ...values);
  const peakIdx = values.indexOf(peak);
  const avg = values.length ? total / values.length : 0;
  const range = dayRange(state.days);
  box.innerHTML = statTiles([
    ["合计" + label, total],
    ["日均", avg.toFixed(1)],
    ["峰值", peak, peakIdx >= 0 && peak > 0 ? range[peakIdx].slice(5) : ""],
    ["有数据天数", values.filter((v) => v > 0).length + " / " + values.length]
  ]);
}

function statTiles(items) {
  return items.map(([label, value, sub]) =>
    `<div class="stat"><div class="label">${label}</div>` +
    `<div class="value">${value}${sub ? `<small>${sub}</small>` : ""}</div></div>`
  ).join("");
}
// ─── chart (single or multi-project compare) ────────────────────────────────

// Geometry kept in module scope so the hover handler can map pixels → index.
let chartGeo = null;

function renderLegend() {
  const el = document.getElementById("legend");
  if (!state.compare) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = state.projects.map((p) =>
    `<span class="item"><span class="swatch" style="background:${colorOf(p)}"></span>${PROJECT_LABELS[p] || p}</span>`
  ).join("");
}

function renderChart() {
  const box = document.getElementById("chart");
  const tip = document.getElementById("tooltip");
  const projectsToPlot = state.compare ? state.projects : (state.selected ? [state.selected] : []);
  if (!projectsToPlot.length) {
    box.innerHTML = '<div class="empty">暂无数据</div>';
    chartGeo = null;
    return;
  }

  const days = dayRange(state.days);
  const seriesByProject = {};
  let max = 1;
  for (const p of projectsToPlot) {
    const vals = days.map((d) => metricAt(p, d));
    seriesByProject[p] = vals;
    max = Math.max(max, ...vals);
  }

  const W = Math.max(680, days.length * 22);
  const H = 240;
  const padL = 36, padB = 26, padT = 16, padR = 12;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (i) => padL + (days.length <= 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;

  const gridLines = [0, 0.5, 1].map((f) => {
    const gy = padT + plotH - f * plotH;
    return `<line class="grid-line" x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" />
      <text class="axis-label" x="${padL - 6}" y="${gy + 3}" text-anchor="end">${Math.round(max * f)}</text>`;
  }).join("");

  const lines = projectsToPlot.map((p) => {
    const vals = seriesByProject[p];
    const stroke = state.compare ? colorOf(p) : "var(--accent)";
    const path = vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const dots = state.compare ? "" : vals.map((v, i) =>
      v > 0 ? `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" />` : "").join("");
    return `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="2" />${dots}`;
  }).join("");

  const step = Math.ceil(days.length / 8);
  const xLabels = days.map((d, i) =>
    i % step === 0 ? `<text class="axis-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${d.slice(5)}</text>` : ""
  ).join("");

  box.querySelectorAll("svg").forEach((n) => n.remove());
  box.insertAdjacentHTML("afterbegin", `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="趋势图">
    ${gridLines}
    ${lines}
    <line class="hover-line" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" style="display:none" />
    ${xLabels}
    <rect class="hover-band" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" />
  </svg>`);

  chartGeo = { days, seriesByProject, projectsToPlot, x, W, padL, plotW };
  bindHover(box, tip);
}

function bindHover(box, tip) {
  const svg = box.querySelector("svg");
  const band = svg.querySelector(".hover-band");
  const line = svg.querySelector(".hover-line");
  const hide = () => { tip.hidden = true; line.style.display = "none"; };

  band.addEventListener("mousemove", (e) => {
    if (!chartGeo) return;
    const rect = svg.getBoundingClientRect();
    const scale = chartGeo.W / rect.width;
    const px = (e.clientX - rect.left) * scale;
    const { days, x } = chartGeo;
    // Nearest day index to the cursor.
    let idx = 0, best = Infinity;
    for (let i = 0; i < days.length; i++) {
      const d = Math.abs(x(i) - px);
      if (d < best) { best = d; idx = i; }
    }
    line.setAttribute("x1", x(idx)); line.setAttribute("x2", x(idx));
    line.style.display = "";

    const rows = chartGeo.projectsToPlot.map((p) => {
      const v = chartGeo.seriesByProject[p][idx];
      const sw = state.compare ? `<span class="swatch" style="background:${colorOf(p)}"></span>` : "";
      const name = state.compare ? (PROJECT_LABELS[p] || p) : METRIC_LABELS[state.metric];
      return `<div class="t-row">${sw}${name}: <strong>${v}</strong></div>`;
    }).join("");
    tip.innerHTML = `<div class="t-day">${days[idx]}</div>${rows}`;
    tip.hidden = false;
    const left = (x(idx) / chartGeo.W) * rect.width + box.scrollLeft;
    tip.style.left = left + "px";
    tip.style.top = "20px";
  });
  band.addEventListener("mouseleave", hide);
}
// ─── detail table ───────────────────────────────────────────────────────────

function renderTable() {
  const table = document.getElementById("table");
  const days = dayRange(state.days).slice().reverse();

  if (state.compare) {
    const head = `<thead><tr><th>日期</th>${state.projects.map((p) =>
      `<th>${PROJECT_LABELS[p] || p}</th>`).join("")}</tr></thead>`;
    const body = days.map((d) =>
      `<tr><td>${d}</td>${state.projects.map((p) =>
        `<td>${metricAt(p, d)}</td>`).join("")}</tr>`).join("");
    table.innerHTML = head + `<tbody>${body}</tbody>`;
    return;
  }

  const p = state.selected;
  if (!p) { table.innerHTML = ""; return; }
  const rows = days.map((d) => {
    const r = (state.byProject[p] && state.byProject[p][d]) || { dau: 0, newUsers: 0, events: 0 };
    return `<tr><td>${d}</td><td>${r.dau}</td><td>${r.newUsers}</td><td>${r.events}</td></tr>`;
  }).join("");
  table.innerHTML = `<thead><tr><th>日期</th><th>活跃人数</th><th>新增</th><th>事件数</th></tr></thead><tbody>${rows}</tbody>`;
}

// ─── tabs + compare toggle ───────────────────────────────────────────────────

function renderTabs() {
  const tabs = document.getElementById("tabs");
  tabs.innerHTML = "";
  for (const p of state.projects) {
    const b = document.createElement("button");
    b.textContent = PROJECT_LABELS[p] || p;
    b.className = (!state.compare && p === state.selected) ? "active" : "";
    b.disabled = state.compare;
    b.addEventListener("click", () => { state.selected = p; render(); });
    tabs.appendChild(b);
  }
  const cmp = document.createElement("button");
  cmp.textContent = "对比全部";
  cmp.className = "compare-toggle" + (state.compare ? " active" : "");
  cmp.addEventListener("click", () => { state.compare = !state.compare; render(); });
  tabs.appendChild(cmp);

  const title = state.compare
    ? `全部项目 · ${METRIC_LABELS[state.metric]}对比`
    : `${PROJECT_LABELS[state.selected] || state.selected || ""} · 趋势`;
  document.getElementById("detail-title").textContent = title;
}

function render() {
  renderCards();
  renderTabs();
  renderStats();
  renderLegend();
  renderChart();
  renderTable();
  document.getElementById("updated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN");
}

// ─── event wiring ─────────────────────────────────────────────────────────────

document.getElementById("range").addEventListener("change", (e) => {
  state.days = Number(e.target.value);
  load();
});
document.getElementById("refresh").addEventListener("click", () => load());
document.querySelectorAll(".metric-toggle button").forEach((b) => {
  b.addEventListener("click", () => {
    state.metric = b.dataset.metric;
    document.querySelectorAll(".metric-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    render();
  });
});

load();
setInterval(() => { if (!state.loading) load(); }, 60000);



