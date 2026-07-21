const http = require('node:http');
const path = require('node:path');
const { createApp } = require('./app');

function positiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value == null || value === '' ? String(fallback) : value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function boolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('METRICS_TRUST_PROXY must be true or false');
}

function parseOrigins(value = '') {
  return value.split(',').map(item => item.trim()).filter(Boolean).map(item => {
    const url = new URL(item);
    if (url.origin !== item) throw new Error('METRICS_ALLOWED_ORIGINS entries must be origins without paths');
    return url.origin;
  });
}

function isLoopback(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(host);
}

function loadRuntimeConfig(env = process.env) {
  const host = env.METRICS_HOST || '127.0.0.1';
  const adminToken = env.METRICS_ADMIN_TOKEN || '';
  const production = env.NODE_ENV === 'production';
  if ((production || !isLoopback(host)) && Buffer.byteLength(adminToken) < 32) {
    throw new Error('METRICS_ADMIN_TOKEN must contain at least 32 bytes in production or outside loopback');
  }
  return {
    host,
    port: positiveInteger(env.PORT, 8787, 'PORT'),
    dbFile: env.METRICS_DB || path.join(__dirname, 'data', 'metrics.sqlite'),
    adminToken,
    allowedOrigins: parseOrigins(env.METRICS_ALLOWED_ORIGINS),
    trustProxy: boolean(env.METRICS_TRUST_PROXY, false),
    collectRateLimit: positiveInteger(env.METRICS_COLLECT_RATE_LIMIT, 300, 'METRICS_COLLECT_RATE_LIMIT'),
    readRateLimit: positiveInteger(env.METRICS_READ_RATE_LIMIT, 120, 'METRICS_READ_RATE_LIMIT'),
    maxConnections: positiveInteger(env.METRICS_MAX_CONNECTIONS, 100, 'METRICS_MAX_CONNECTIONS')
  };
}

function startServer(runtimeConfig = loadRuntimeConfig()) {
  const { handler } = createApp(runtimeConfig);
  const server = http.createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = runtimeConfig.maxConnections;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.listen(runtimeConfig.port, runtimeConfig.host, () => {
    // eslint-disable-next-line no-console
    console.log(`vb-metrics dashboard on http://${runtimeConfig.host}:${runtimeConfig.port}`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { loadRuntimeConfig, startServer };
