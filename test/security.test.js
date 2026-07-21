const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRuntimeConfig } = require('../index');
const { createRateLimiter, isAllowedOrigin, secureTokenMatch } = require('../security');

test('external binding requires a strong admin token', () => {
  assert.throws(() => loadRuntimeConfig({ METRICS_HOST: '0.0.0.0' }), /METRICS_ADMIN_TOKEN/);
  const config = loadRuntimeConfig({ METRICS_HOST: '0.0.0.0', METRICS_ADMIN_TOKEN: 'x'.repeat(32) });
  assert.equal(config.host, '0.0.0.0');
});

test('default runtime binds only to loopback', () => {
  assert.equal(loadRuntimeConfig({}).host, '127.0.0.1');
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: 'production' }), /METRICS_ADMIN_TOKEN/);
});

test('origin allowlist accepts local development and exact configured origins', () => {
  assert.equal(isAllowedOrigin('http://localhost:3000', []), true);
  assert.equal(isAllowedOrigin('https://pet.example.com', ['https://pet.example.com']), true);
  assert.equal(isAllowedOrigin('http://pet.example.com', ['http://pet.example.com']), false);
  assert.equal(isAllowedOrigin('https://attacker.example', ['https://pet.example.com']), false);
});

test('admin token comparison is exact', () => {
  assert.equal(secureTokenMatch('x'.repeat(32), 'x'.repeat(32)), true);
  assert.equal(secureTokenMatch('x'.repeat(31), 'x'.repeat(32)), false);
});

test('rate limiter bounds unique clients', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 1, clock: () => 1_000 });
  assert.equal(limiter.check('one').allowed, true);
  assert.equal(limiter.check('two').allowed, false);
  assert.equal(limiter.size(), 1);
});

test('rate limiter rejects invalid capacity configuration', () => {
  assert.throws(() => createRateLimiter({ limit: 1, windowMs: 1_000, maxKeys: 0 }), /maxKeys/);
});
