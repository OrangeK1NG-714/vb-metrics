const crypto = require('node:crypto');

function createRateLimiter({ limit, windowMs, maxKeys = 20_000, clock = () => Date.now() }) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('rate limit must be a positive integer');
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error('rate limit window must be positive');
  if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) throw new Error('rate limit maxKeys must be positive');
  const entries = new Map();
  let nextSweepAt = 0;

  function sweep(now) {
    if (now < nextSweepAt && entries.size < maxKeys) return;
    entries.forEach((entry, key) => {
      if (entry.resetAt <= now) entries.delete(key);
    });
    nextSweepAt = now + Math.min(windowMs, 60_000);
  }

  function check(rawKey) {
    const now = clock();
    const key = String(rawKey || 'unknown').slice(0, 160);
    sweep(now);
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && entries.size >= maxKeys) {
        return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil(windowMs / 1000) };
      }
      entry = { count: 0, resetAt: now + windowMs };
      entries.set(key, entry);
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    if (entry.count >= limit) return { allowed: false, remaining: 0, retryAfterSeconds };
    entry.count += 1;
    return { allowed: true, remaining: limit - entry.count, retryAfterSeconds };
  }

  return { check, size: () => entries.size, limit };
}

function cleanIp(value) {
  const candidate = String(value || '').split(',', 1)[0].trim();
  return candidate.length <= 64 && /^[0-9a-fA-F:.]+$/.test(candidate) ? candidate : '';
}

function clientIp(request, trustProxy = false) {
  if (trustProxy) {
    const forwarded = cleanIp(request.headers?.['x-forwarded-for']) || cleanIp(request.headers?.['x-real-ip']);
    if (forwarded) return forwarded;
  }
  return cleanIp(request.socket?.remoteAddress) || 'unknown';
}

function isAllowedOrigin(origin, allowedOrigins = []) {
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) return false;
  if (local) return true;
  return allowedOrigins.includes(parsed.origin);
}

function secureTokenMatch(received, expected) {
  if (!expected) return true;
  if (typeof received !== 'string') return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { createRateLimiter, clientIp, isAllowedOrigin, secureTokenMatch };
