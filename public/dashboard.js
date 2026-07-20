"use strict";

const PROJECT_LABELS = {
  greenpoly: "GreenPoly 独立站",
  "pet-mbti": "宠物 MBTI",
  "id-photo": "证件照小程序",
  followmate: "FollowMate 桌面版"
};

const state = {
  days: 30,
  projects: [],
  byProject: {}, // project -> { day -> {dau,newUsers,events} }
  selected: null,
  metric: "dau"
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

async function load() {
  const res = await fetch(`/api/summary?days=${state.days}`);
  const json = await res.json();
  state.projects = json.projects || [];
  state.byProject = {};
  for (const p of state.projects) state.byProject[p] = {};
  for (const row of json.rows || []) {
    state.byProject[row.project][row.day] = { dau: row.dau, newUsers: row.newUsers, events: row.events };
  }
  if (!state.selected) state.selected = state.projects[0] || null;
  render();
}

function metricAt(project, day) {
  const rec = state.byProject[project] && state.byProject[project][day];
  return rec ? rec[state.metric] : 0;
}

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

function renderChart() {
  const box = document.getElementById("chart");
  const p = state.selected;
  if (!p) { box.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const days = dayRange(state.days);
  const values = days.map((d) => metricAt(p, d));
  const max = Math.max(1, ...values);
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

  const path = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = values.map((v, i) => v > 0 ? `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"><title>${days[i]}: ${v}</title></circle>` : "").join("");
  const step = Math.ceil(days.length / 8);
  const xLabels = days.map((d, i) => i % step === 0 ? `<text class="axis-label" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${d.slice(5)}</text>` : "").join("");

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">
    ${gridLines}
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" />
    ${dots}${xLabels}
  </svg>`;
}

function renderTable() {
  const p = state.selected;
  const table = document.getElementById("table");
  if (!p) { table.innerHTML = ""; return; }
  const days = dayRange(state.days).slice().reverse();
  const rows = days.map((d) => {
    const r = (state.byProject[p] && state.byProject[p][d]) || { dau: 0, newUsers: 0, events: 0 };
    return `<tr><td>${d}</td><td>${r.dau}</td><td>${r.newUsers}</td><td>${r.events}</td></tr>`;
  }).join("");
  table.innerHTML = `<thead><tr><th>日期</th><th>活跃人数</th><th>新增</th><th>事件数</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderTabs() {
  const tabs = document.getElementById("tabs");
  tabs.innerHTML = "";
  for (const p of state.projects) {
    const b = document.createElement("button");
    b.textContent = PROJECT_LABELS[p] || p;
    b.className = p === state.selected ? "active" : "";
    b.addEventListener("click", () => { state.selected = p; render(); });
    tabs.appendChild(b);
  }
  document.getElementById("detail-title").textContent = (PROJECT_LABELS[state.selected] || state.selected || "") + " · 趋势";
}

function render() {
  renderCards();
  renderTabs();
  renderChart();
  renderTable();
  document.getElementById("updated").textContent = "更新于 " + new Date().toLocaleTimeString("zh-CN");
}

document.getElementById("range").addEventListener("change", (e) => {
  state.days = Number(e.target.value);
  load();
});
document.querySelectorAll(".metric-toggle button").forEach((b) => {
  b.addEventListener("click", () => {
    state.metric = b.dataset.metric;
    document.querySelectorAll(".metric-toggle button").forEach((x) => x.classList.toggle("active", x === b));
    renderChart();
  });
});

load();
setInterval(load, 60000);
