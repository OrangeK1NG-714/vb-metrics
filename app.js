const fs = require('node:fs');
const path = require('node:path');
const { createStore, PROJECTS } = require('./db');
const { createRateLimiter, clientIp, isAllowedOrigin, secureTokenMatch } = require('./security');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024;
const PROJECT_SET = new Set(PROJECTS);
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
});
const EVENT_SET = Object.freeze({
  greenpoly: new Set([
    'page_view', 'dwell', 'page_exit', 'scroll_depth', 'cta_click',
    'whatsapp_click', 'email_click', 'outbound_click', 'form_submit',
    'form_field_focus', 'inquiry_intent', 'product_card_impression'
  ]),
  'pet-mbti': new Set(['start', 'complete', 'share', 'intent']),
  'id-photo': new Set(['open', 'paid']),
  followmate: new Set(['open', 'active'])
});

function isSafe(value, maxLen) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLen;
}

// Minimal validation mirroring greenpoly's TrackSchema intent: whitelist the
// project, bound every string, drop anything unexpected. Returns a clean record
// or a string error code.
function validate(body, now = Date.now()) {
  if (!body || typeof body !== 'object') return 'invalid_payload';
  // Accept greenpoly's {siteId} alias as project for drop-in reuse.
  const project = body.project || body.siteId;
  if (!PROJECT_SET.has(project)) return 'unknown_project';
  if (!isSafe(body.event, 64) || !EVENT_SET[project].has(body.event)) return 'invalid_event';
  const anonId = body.anonId || body.anon_id;
  if (!isSafe(anonId, 128) || !/^[A-Za-z0-9_-]+$/.test(anonId)) return 'invalid_anon_id';

  const ts = Number(body.ts);
  let props = null;
  if (body.props && typeof body.props === 'object') props = body.props;
  else if (body.properties && typeof body.properties === 'object') props = body.properties;

  if (props) {
    if (Array.isArray(props) || Object.keys(props).length > 16) return 'invalid_props';
    for (const [key, value] of Object.entries(props)) {
      if (key.length > 64 || !['string', 'number', 'boolean'].includes(typeof value)) return 'invalid_props';
      if (typeof value === 'string' && value.length > 512) return 'invalid_props';
      if (typeof value === 'number' && !Number.isFinite(value)) return 'invalid_props';
    }
    if (Buffer.byteLength(JSON.stringify(props)) > 2 * 1024) return 'invalid_props';
  }

  const trustedTs = Number.isFinite(ts) && Math.abs(ts - now) <= 5 * 60 * 1000 ? ts : undefined;
  return { project, event: body.event, anonId, ts: trustedTs, props };
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': typeof payload === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
    ...headers
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_err) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return send(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { ok: false, error: 'not_found' });
    const ext = path.extname(filePath);
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...SECURITY_HEADERS });
    res.end(data);
  });
}

function createApp({
  dbFile = ':memory:',
  store,
  allowedOrigins = [],
  adminToken = '',
  trustProxy = false,
  collectRateLimit = 300,
  readRateLimit = 120,
  clock = () => Date.now()
} = {}) {
  const dataStore = store || createStore(dbFile);
  const collectLimiter = createRateLimiter({ limit: collectRateLimit, windowMs: 60_000, clock });
  const readLimiter = createRateLimiter({ limit: readRateLimit, windowMs: 60_000, clock });

  function corsHeaders(req) {
    const origin = req.headers?.origin;
    if (!origin || !isAllowedOrigin(origin, allowedOrigins)) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-max-age': '600',
      vary: 'Origin'
    };
  }

  function rateLimited(req, res, limiter, cors) {
    const decision = limiter.check(clientIp(req, trustProxy));
    if (decision.allowed) return false;
    send(res, 429, { ok: false, error: 'rate_limited' }, {
      ...cors,
      'retry-after': String(decision.retryAfterSeconds),
      'x-ratelimit-limit': String(limiter.limit),
      'x-ratelimit-remaining': '0'
    });
    return true;
  }

  function authorized(req) {
    if (!adminToken) return true;
    const authorization = req.headers?.authorization || '';
    const received = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    return secureTokenMatch(received, adminToken);
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers?.origin;
    const originAllowed = isAllowedOrigin(origin, allowedOrigins);
    const cors = corsHeaders(req);

    if (req.method === 'OPTIONS') {
      return originAllowed ? send(res, 204, '', cors) : send(res, 403, { ok: false, error: 'origin_forbidden' });
    }

    if (req.method === 'POST' && url.pathname === '/api/collect') {
      if (!originAllowed) return send(res, 403, { ok: false, error: 'origin_forbidden' });
      if (rateLimited(req, res, collectLimiter, cors)) return;
      try {
        const body = await readJson(req);
        const result = validate(body, clock());
        if (typeof result === 'string') return send(res, 400, { ok: false, error: result }, cors);
        dataStore.record(result);
        return send(res, 200, { ok: true }, cors);
      } catch (err) {
        const code = err.message === 'payload_too_large' ? 413 : 400;
        return send(res, code, { ok: false, error: err.message || 'bad_request' }, cors);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/summary') {
      if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
      if (rateLimited(req, res, readLimiter, cors)) return;
      const rows = dataStore.summary(url.searchParams.get('days'));
      return send(res, 200, { ok: true, projects: PROJECTS, rows }, cors);
    }

    if (req.method === 'GET' && url.pathname === '/api/recent') {
      if (!authorized(req)) return send(res, 401, { ok: false, error: 'unauthorized' });
      if (rateLimited(req, res, readLimiter, cors)) return;
      const rows = dataStore.recent(url.searchParams.get('limit'));
      const lastSeen = dataStore.lastSeen();
      return send(res, 200, { ok: true, rows, lastSeen }, cors);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true }, cors);
    }

    if (req.method === 'GET') return serveStatic(res, url.pathname);

    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  };

  return { handler, store: dataStore };
}

module.exports = { createApp, validate, PROJECTS };
