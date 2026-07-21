const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { createStore, PROJECTS } = require("../db");
const { validate, createApp } = require("../app");

// ─── db / DAU logic ────────────────────────────────────────────────────────

describe("createStore – record & summary", () => {
  let store;
  beforeEach(() => { store = createStore(":memory:"); });

  it("records an event and returns it in summary", () => {
    store.record({ project: "pet-mbti", event: "open", anonId: "u1" });
    const rows = store.summary(30);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, "pet-mbti");
    assert.equal(rows[0].dau, 1);
    assert.equal(rows[0].events, 1);
  });

  it("DAU deduplicates same anon_id on the same day", () => {
    store.record({ project: "pet-mbti", event: "open", anonId: "u1" });
    store.record({ project: "pet-mbti", event: "active", anonId: "u1" });
    store.record({ project: "pet-mbti", event: "active", anonId: "u1" });
    const rows = store.summary(30);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dau, 1);
    assert.equal(rows[0].events, 3);
  });

  it("DAU counts two different anon_ids as 2", () => {
    store.record({ project: "pet-mbti", event: "open", anonId: "u1" });
    store.record({ project: "pet-mbti", event: "open", anonId: "u2" });
    const rows = store.summary(30);
    assert.equal(rows[0].dau, 2);
  });

  it("projects are counted independently", () => {
    store.record({ project: "pet-mbti", event: "open", anonId: "u1" });
    store.record({ project: "id-photo", event: "open", anonId: "u1" });
    const rows = store.summary(30);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.equal(r.dau, 1);
  });

  it("new user is counted only on their first day", () => {
    const today = store.dayKey(Date.now());
    const yesterday = store.dayKey(Date.now() - 86400000);
    store.record({ project: "pet-mbti", event: "open", anonId: "u1", ts: Date.now() - 86400000 });
    store.record({ project: "pet-mbti", event: "open", anonId: "u1", ts: Date.now() });
    const rows = store.summary(30);
    const yd = rows.find((r) => r.day === yesterday);
    const td = rows.find((r) => r.day === today);
    assert.ok(yd, "yesterday row exists");
    assert.equal(yd.newUsers, 1, "new on first appearance");
    assert.equal(td.newUsers, 0, "not new again today");
  });

  it("summary spans the requested number of days only", () => {
    const old = Date.now() - 40 * 86400000;
    store.record({ project: "pet-mbti", event: "open", anonId: "x", ts: old });
    store.record({ project: "pet-mbti", event: "open", anonId: "y" });
    const rows = store.summary(30);
    const hasOld = rows.some((r) => r.day === store.dayKey(old));
    assert.equal(hasOld, false, "40-day-old event excluded from 30-day summary");
  });
});

// ─── payload validation ─────────────────────────────────────────────────────

describe("validate", () => {
  it("accepts a well-formed payload", () => {
    const r = validate({ project: "pet-mbti", event: "start", anonId: "u1" });
    assert.equal(typeof r, "object");
    assert.equal(r.project, "pet-mbti");
  });

  it("accepts greenpoly-style {siteId, properties} alias", () => {
    const r = validate({ siteId: "greenpoly", event: "page_view", anon_id: "u1", properties: { a: 1 } });
    assert.equal(r.project, "greenpoly");
    assert.deepEqual(r.props, { a: 1 });
  });

  it("rejects unknown project", () => {
    assert.equal(validate({ project: "nope", event: "open", anonId: "u1" }), "unknown_project");
  });

  it("rejects missing anonId", () => {
    assert.equal(validate({ project: "pet-mbti", event: "start" }), "invalid_anon_id");
  });

  it("rejects over-long event", () => {
    assert.equal(validate({ project: "pet-mbti", event: "x".repeat(65), anonId: "u1" }), "invalid_event");
  });

  it("every whitelisted project validates", () => {
    const events = { greenpoly: "page_view", "pet-mbti": "start", "id-photo": "open", followmate: "open" };
    for (const p of PROJECTS) {
      assert.equal(typeof validate({ project: p, event: events[p], anonId: "u1" }), "object");
    }
  });

  it("rejects unknown events and oversized properties", () => {
    assert.equal(validate({ project: "pet-mbti", event: "open", anonId: "u1" }), "invalid_event");
    assert.equal(validate({
      project: "pet-mbti", event: "start", anonId: "u1", props: { value: "x".repeat(513) }
    }), "invalid_props");
  });
});

// ─── HTTP endpoints (via handler, in-memory store) ──────────────────────────

function mockRes() {
  return {
    statusCode: 0, headers: {}, body: "",
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body || ""; this.done = true; }
  };
}

function fireGet(handler, url, headers = {}) {
  const req = { method: "GET", url, headers, socket: { remoteAddress: "127.0.0.1" }, on() {} };
  const res = mockRes();
  handler(req, res);
  return res;
}

function fireGetAsync(handler, url, headers = {}) {
  return new Promise((resolve) => {
    const req = { method: "GET", url, headers, socket: { remoteAddress: "127.0.0.1" }, on() {} };
    const res = mockRes();
    const end = res.end;
    res.end = function finish(body) {
      end.call(this, body);
      resolve(this);
    };
    handler(req, res);
  });
}

function fireOptions(handler, origin) {
  const req = {
    method: "OPTIONS",
    url: "/api/collect",
    headers: { origin },
    socket: { remoteAddress: "127.0.0.1" },
    on() {}
  };
  const res = mockRes();
  handler(req, res);
  return res;
}

describe("http handler", () => {
  it("GET /api/summary returns projects list and ok", async () => {
    const { handler } = createApp({ dbFile: ":memory:" });
    const res = fireGet(handler, "/api/summary?days=7");
    const json = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(json.projects, PROJECTS);
  });

  it("GET /health is ok", () => {
    const { handler } = createApp({ dbFile: ":memory:" });
    const res = fireGet(handler, "/health");
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
    assert.match(res.headers["content-security-policy"], /default-src 'self'/);
  });

  it("serves the dashboard with security headers", async () => {
    const { handler } = createApp({ dbFile: ":memory:" });
    const res = await fireGetAsync(handler, "/");
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  });

  it("GET /api/recent returns newest-first rows and per-project lastSeen", () => {
    const { handler, store } = createApp({ dbFile: ":memory:" });
    store.record({ project: "pet-mbti", event: "open", anonId: "u1", ts: 1000 });
    store.record({ project: "id-photo", event: "paid", anonId: "u2", ts: 2000 });
    const res = fireGet(handler, "/api/recent?limit=10");
    const json = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(json.ok, true);
    assert.equal(json.rows[0].project, "id-photo", "newest event first");
    assert.equal(json.lastSeen["id-photo"], 2000);
    assert.equal(json.lastSeen["pet-mbti"], 1000);
  });

  it("protects read APIs with an admin token", () => {
    const { handler } = createApp({ dbFile: ":memory:", adminToken: "a".repeat(32) });
    assert.equal(fireGet(handler, "/api/summary").statusCode, 401);
    const allowed = fireGet(handler, "/api/summary", { authorization: `Bearer ${"a".repeat(32)}` });
    assert.equal(allowed.statusCode, 200);
  });

  it("rate limits dashboard reads", () => {
    const { handler } = createApp({ dbFile: ":memory:", readRateLimit: 1 });
    assert.equal(fireGet(handler, "/api/summary").statusCode, 200);
    assert.equal(fireGet(handler, "/api/summary").statusCode, 429);
  });

  it("rejects foreign CORS origins and reflects exact allowed origins", () => {
    const { handler } = createApp({ dbFile: ":memory:", allowedOrigins: ["https://pet.example.com"] });
    assert.equal(fireOptions(handler, "https://attacker.example").statusCode, 403);
    const allowed = fireOptions(handler, "https://pet.example.com");
    assert.equal(allowed.statusCode, 204);
    assert.equal(allowed.headers["access-control-allow-origin"], "https://pet.example.com");
  });
});
