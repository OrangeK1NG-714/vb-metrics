const fs = require('node:fs');
const path = require('node:path');
const { createStore, PROJECTS } = require('./db');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024;
const PROJECT_SET = new Set(PROJECTS);

function isSafe(value, maxLen) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLen;
}

// Minimal validation mirroring greenpoly's TrackSchema intent: whitelist the
// project, bound every string, drop anything unexpected. Returns a clean record
// or a string error code.
function validate(body) {
  if (!body || typeof body !== 'object') return 'invalid_payload';
  // Accept greenpoly's {siteId} alias as project for drop-in reuse.
  const project = body.project || body.siteId;
  if (!PROJECT_SET.has(project)) return 'unknown_project';
  if (!isSafe(body.event, 64)) return 'invalid_event';
  const anonId = body.anonId || body.anon_id;
  if (!isSafe(anonId, 128)) return 'invalid_anon_id';

  const ts = Number(body.ts);
  let props = null;
  if (body.props && typeof body.props === 'object') props = body.props;
  else if (body.properties && typeof body.properties === 'object') props = body.properties;

  return { project, event: body.event, anonId, ts: Number.isFinite(ts) ? ts : undefined, props };
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': typeof payload === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
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
  const filePath = path.join(PUBLIC_DIR, rel);
  // Contain to PUBLIC_DIR — never serve outside it.
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { ok: false, error: 'forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { ok: false, error: 'not_found' });
    const ext = path.extname(filePath);
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  });
}

function createApp({ dbFile = ':memory:', store } = {}) {
  const dataStore = store || createStore(dbFile);

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS' };

    if (req.method === 'OPTIONS') return send(res, 204, '', cors);

    if (req.method === 'POST' && url.pathname === '/api/collect') {
      try {
        const body = await readJson(req);
        const result = validate(body);
        if (typeof result === 'string') return send(res, 400, { ok: false, error: result }, cors);
        dataStore.record(result);
        return send(res, 200, { ok: true }, cors);
      } catch (err) {
        const code = err.message === 'payload_too_large' ? 413 : 400;
        return send(res, code, { ok: false, error: err.message || 'bad_request' }, cors);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/summary') {
      const rows = dataStore.summary(url.searchParams.get('days'));
      return send(res, 200, { ok: true, projects: PROJECTS, rows }, cors);
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
