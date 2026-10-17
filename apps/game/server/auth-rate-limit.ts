import { createHash } from 'node:crypto';

import {
  consumePersistentAuthRateLimit,
  releasePersistentAuthRateLimitAttempt,
  resetPersistentAuthRateLimit,
} from './local-player-identity';

export type AuthRateLimitScope = 'login-ip' | 'login-account' | 'login-pair';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function positiveInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function policy() {
  return {
    maximum: positiveInteger(process.env.BOX_LOGIN_RATE_LIMIT_MAX_ATTEMPTS, 10, 10_000),
    windowMs: positiveInteger(process.env.BOX_LOGIN_RATE_LIMIT_WINDOW_MS, 5 * 60_000, 24 * 60 * 60_000),
  };
}

function key(scope: AuthRateLimitScope, address: string) {
  return `${scope}:${address}`;
}

export function checkAuthRateLimit(scope: AuthRateLimitScope, address: string, now = Date.now()) {
  const current = buckets.get(key(scope, address));
  const { maximum } = policy();
  if (!current || current.resetAt <= now || current.count < maximum) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

export function recordAuthRateLimitAttempt(scope: AuthRateLimitScope, address: string, now = Date.now()) {
  const bucketKey = key(scope, address);
  const current = buckets.get(bucketKey);
  const { windowMs } = policy();
  const active = current && current.resetAt > now
    ? current
    : { count: 0, resetAt: now + windowMs };
  active.count += 1;
  buckets.set(bucketKey, active);
  return active;
}

export function resetAuthRateLimit(scope: AuthRateLimitScope, address: string) {
  buckets.delete(key(scope, address));
}

export function releaseAuthRateLimitAttempt(scope: AuthRateLimitScope, address: string) {
  const bucketKey = key(scope, address);
  const current = buckets.get(bucketKey);
  if (!current) return;
  current.count -= 1;
  if (current.count <= 0) buckets.delete(bucketKey);
}

function opaqueRateKey(...values: string[]) {
  return createHash('sha256').update(values.join('\0')).digest('hex');
}

function playerLoginBuckets(address: string, username: string) {
  const account = username.trim().toLowerCase();
  return [
    { scope: 'login-ip' as const, rateKey: address },
    { scope: 'login-account' as const, rateKey: opaqueRateKey(account) },
    { scope: 'login-pair' as const, rateKey: opaqueRateKey(address, account) },
  ];
}

export async function consumeAuthRateLimit(scope: AuthRateLimitScope, address: string) {
  const { maximum, windowMs } = policy();
  const persistent = await consumePersistentAuthRateLimit(scope, address, maximum, windowMs);
  if (persistent) return persistent;

  const entry = recordAuthRateLimitAttempt(scope, address);
  if (entry.count <= maximum) return { allowed: true, retryAfterSeconds: 0 };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)),
  };
}

export async function clearAuthRateLimit(scope: AuthRateLimitScope, address: string) {
  resetAuthRateLimit(scope, address);
  await resetPersistentAuthRateLimit(scope, address);
}

export async function consumePlayerLoginRateLimit(address: string, username: string) {
  const results = await Promise.all(
    playerLoginBuckets(address, username).map(({ scope, rateKey }) =>
      consumeAuthRateLimit(scope, rateKey)),
  );
  const denied = results.filter((result) => !result.allowed);
  return denied.length
    ? {
        allowed: false,
        retryAfterSeconds: Math.max(...denied.map((result) => result.retryAfterSeconds)),
      }
    : { allowed: true, retryAfterSeconds: 0 };
}

export async function clearSuccessfulPlayerLoginRateLimits(address: string, username: string) {
  const [ipBucket, ...accountBuckets] = playerLoginBuckets(address, username);
  releaseAuthRateLimitAttempt(ipBucket.scope, ipBucket.rateKey);
  await releasePersistentAuthRateLimitAttempt(ipBucket.scope, ipBucket.rateKey);
  await Promise.all(accountBuckets.map(async ({ scope, rateKey }) => {
    resetAuthRateLimit(scope, rateKey);
    await resetPersistentAuthRateLimit(scope, rateKey);
  }));
}

export function resetAuthRateLimitsForTests() {
  buckets.clear();
}
