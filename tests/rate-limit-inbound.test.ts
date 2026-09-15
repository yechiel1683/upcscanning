import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetEnvCache } from '@/lib/env';
import { clientIp, rateLimitKey } from '@/server/api/client-ip';
import { LIMITS, limit } from '@/server/api/guard';
import {
  checkRate,
  peekRate,
  resetRateLimits,
  trackedKeyCount,
} from '@/server/lib/rate-limit-inbound';
import {
  guestBudgetStatus,
  releaseGuestImages,
  reserveGuestImages,
  resetGuestBudget,
} from '@/server/guest/budget';

/**
 * `/api/guest/batches` is public, unauthenticated, and accepts a hundred
 * products per call — each of which spends real money on search, vision
 * verification and rendering. Nothing stopped a script calling it in a loop.
 *
 * Security code that is merely present is worth nothing, so these cover the
 * ways a limiter looks like it works and does not: a window that resets on a
 * clock edge, an identity the caller can choose for themselves, a budget
 * counted after the spend rather than before it.
 */

beforeEach(() => {
  resetRateLimits();
  resetGuestBudget();
  resetEnvCache();
});

afterEach(() => {
  delete process.env.TRUSTED_PROXY_HOPS;
  delete process.env.GUEST_DAILY_IMAGE_LIMIT;
  resetEnvCache();
});

function request(headers: Record<string, string>): Request {
  return new Request('https://upcscanning.com/api/guest/batches', {
    method: 'POST',
    headers,
  });
}

describe('checkRate', () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it('allows up to the limit and refuses after it', () => {
    const verdicts = [1, 2, 3, 4].map(() => checkRate('k', rule, 1_000));
    expect(verdicts.map((v) => v.allowed)).toEqual([true, true, true, false]);
  });

  it('counts each caller separately', () => {
    for (let i = 0; i < 3; i += 1) checkRate('a', rule, 1_000);
    expect(checkRate('a', rule, 1_000).allowed).toBe(false);
    expect(checkRate('b', rule, 1_000).allowed).toBe(true);
  });

  it('slides, so the allowance is not doubled across a boundary', () => {
    // The bug a fixed window has: spend the whole allowance just before the
    // reset, then the whole allowance again just after, and a "3 per minute"
    // limit passes 6 requests in about a second.
    for (let i = 0; i < 3; i += 1) checkRate('k', rule, 59_000);
    expect(checkRate('k', rule, 60_001).allowed).toBe(false);
  });

  it('lets a caller back in once their oldest request ages out', () => {
    checkRate('k', rule, 1_000);
    checkRate('k', rule, 2_000);
    checkRate('k', rule, 3_000);
    expect(checkRate('k', rule, 61_500).allowed).toBe(true);
  });

  it('does not extend the block when a refused caller keeps trying', () => {
    // Counting refusals would turn a rate limit into an indefinite ban for
    // anyone who retries, and make the retry-after we hand out a lie.
    for (let i = 0; i < 3; i += 1) checkRate('k', rule, 1_000);
    for (let i = 0; i < 20; i += 1) checkRate('k', rule, 30_000);
    expect(checkRate('k', rule, 61_500).allowed).toBe(true);
  });

  it('reports a retry time that is actually long enough', () => {
    for (let i = 0; i < 3; i += 1) checkRate('k', rule, 1_000);
    const verdict = checkRate('k', rule, 31_000);

    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    const retryAt = 31_000 + verdict.retryAfterSeconds * 1000;
    expect(checkRate('k', rule, retryAt).allowed).toBe(true);
  });

  it('peeks without spending a request', () => {
    checkRate('k', rule, 1_000);
    expect(peekRate('k', rule, 1_000)).toBe(2);
    expect(peekRate('k', rule, 1_000)).toBe(2);
  });

  it('keeps its own memory bounded', () => {
    // Forged addresses create one entry each, so an unbounded limiter is the
    // memory exhaustion it exists to prevent.
    for (let i = 0; i < 25_000; i += 1) checkRate(`ip-${i}`, rule, 1_000);
    expect(trackedKeyCount()).toBeLessThanOrEqual(20_000);
  });
});

describe('clientIp', () => {
  it('takes the hop the proxy wrote, not the one the caller sent', () => {
    // The attack: a caller sets x-forwarded-for themselves and every proxy
    // politely appends to it. Reading the leftmost entry lets them pick a new
    // identity per request, and the rate limit does nothing at all.
    expect(clientIp(request({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('gives a forged chain no way to change the answer', () => {
    const forged = Array.from({ length: 50 }, (_, i) => `1.2.3.${i}`).join(', ');
    const seen = clientIp(request({ 'x-forwarded-for': `${forged}, 203.0.113.7` }));
    expect(seen).toBe('203.0.113.7');
  });

  it('counts further left when more proxies are declared', () => {
    process.env.TRUSTED_PROXY_HOPS = '2';
    resetEnvCache();
    expect(clientIp(request({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7',
    );
  });

  it('handles IPv6, brackets and ports', () => {
    expect(clientIp(request({ 'x-forwarded-for': '[2001:db8::1]:443' }))).toBe('2001:db8::1');
    expect(clientIp(request({ 'x-forwarded-for': '192.0.2.1:51234' }))).toBe('192.0.2.1');
  });

  it('refuses junk rather than turning it into a key', () => {
    // A header value is caller-controlled text. Anything that is not an
    // address must not become a bucket name.
    expect(clientIp(request({ 'x-forwarded-for': 'not-an-ip' }))).toBeNull();
    expect(clientIp(request({ 'x-forwarded-for': '<script>alert(1)</script>' }))).toBeNull();
    expect(clientIp(request({ 'x-forwarded-for': '   ' }))).toBeNull();
  });

  it('falls back to a platform header when there is no chain', () => {
    expect(clientIp(request({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
  });

  it('shares one bucket when the caller cannot be identified', () => {
    // Throttling a few people together is recoverable. An unlimited hole is
    // not, so an unknown peer must never mean "no limit".
    expect(rateLimitKey(request({}), 'guestBatch')).toBe('guestBatch:unknown-peer');
  });

  it('keeps unrelated limits in separate buckets', () => {
    // Spending an upload allowance must not lock someone out of signing in.
    const req = request({ 'x-forwarded-for': '203.0.113.7' });
    expect(rateLimitKey(req, 'login')).not.toBe(rateLimitKey(req, 'guestBatch'));
  });
});

describe('the route guard', () => {
  it('refuses with 429 and a retry-after once the ceiling is reached', () => {
    const req = request({ 'x-forwarded-for': '203.0.113.9' });
    for (let i = 0; i < LIMITS.guestBatch.limit; i += 1) {
      expect(limit(req, 'guestBatch')).toBeNull();
    }

    const refused = limit(req, 'guestBatch');
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('does not let one caller exhaust another caller`s allowance', () => {
    for (let i = 0; i < LIMITS.guestBatch.limit + 3; i += 1) {
      limit(request({ 'x-forwarded-for': '203.0.113.9' }), 'guestBatch');
    }
    expect(limit(request({ 'x-forwarded-for': '203.0.113.10' }), 'guestBatch')).toBeNull();
  });

  it('holds the expensive endpoint tighter than the cheap ones', () => {
    // A guest batch is up to a hundred image pipelines; a session is a cookie.
    expect(LIMITS.guestBatch.limit).toBeLessThan(LIMITS.guestSession.limit);
  });
});

describe('the daily trial budget', () => {
  it('allows work up to the ceiling', () => {
    process.env.GUEST_DAILY_IMAGE_LIMIT = '100';
    resetEnvCache();
    expect(reserveGuestImages(60).allowed).toBe(true);
    expect(reserveGuestImages(40).allowed).toBe(true);
    expect(reserveGuestImages(1).allowed).toBe(false);
  });

  it('reserves before the work runs, not after it finishes', () => {
    // A counter that only moves on completion is behind by however many
    // batches are in flight, which is exactly the window a flood walks
    // through: a hundred simultaneous requests all read zero and all proceed.
    process.env.GUEST_DAILY_IMAGE_LIMIT = '100';
    resetEnvCache();

    const verdicts = Array.from({ length: 10 }, () => reserveGuestImages(20));
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(5);
    expect(guestBudgetStatus().used).toBe(100);
  });

  it('refuses a whole batch rather than admitting part of it', () => {
    // Half a spreadsheet processed and the rest reported as failures looks
    // like the product being broken rather than the trial being full.
    process.env.GUEST_DAILY_IMAGE_LIMIT = '100';
    resetEnvCache();
    reserveGuestImages(90);

    const verdict = reserveGuestImages(50);
    expect(verdict.allowed).toBe(false);
    expect(guestBudgetStatus().used).toBe(90);
  });

  it('says what is left, so the message is actionable', () => {
    process.env.GUEST_DAILY_IMAGE_LIMIT = '100';
    resetEnvCache();
    reserveGuestImages(90);
    expect(reserveGuestImages(50).message).toMatch(/10 images left today/);
  });

  it('gives back a reservation for work that never ran', () => {
    process.env.GUEST_DAILY_IMAGE_LIMIT = '100';
    resetEnvCache();
    reserveGuestImages(100);
    releaseGuestImages(100);
    expect(reserveGuestImages(100).allowed).toBe(true);
  });

  it('never releases into a negative balance', () => {
    process.env.GUEST_DAILY_IMAGE_LIMIT = '100';
    resetEnvCache();
    reserveGuestImages(10);
    releaseGuestImages(999);
    expect(guestBudgetStatus().used).toBe(0);
  });

  it('resets on a new UTC day', () => {
    process.env.GUEST_DAILY_IMAGE_LIMIT = '100';
    resetEnvCache();
    const day1 = Date.parse('2026-09-15T23:59:00Z');
    const day2 = Date.parse('2026-09-16T00:01:00Z');

    expect(reserveGuestImages(100, day1).allowed).toBe(true);
    expect(reserveGuestImages(1, day1).allowed).toBe(false);
    expect(reserveGuestImages(100, day2).allowed).toBe(true);
  });

  it('closes the trial entirely when the limit is zero', () => {
    // The switch to reach for if this ever has to be shut off in a hurry.
    process.env.GUEST_DAILY_IMAGE_LIMIT = '0';
    resetEnvCache();
    expect(reserveGuestImages(1).allowed).toBe(false);
  });
});
