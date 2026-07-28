import { beforeEach, describe, expect, it } from 'vitest';

import { resetRateLimits, withRateLimit } from '@/server/lib/rate-limit';

/**
 * The limiter exists because bulk processing is exactly the workload that gets
 * an account throttled: eight workers hitting a hundred-a-day free tier will
 * spend the whole allowance in seconds and take 429s for the rest of the run.
 */

beforeEach(() => {
  resetRateLimits();
});

describe('withRateLimit', () => {
  it('runs a single call immediately', async () => {
    const started = Date.now();
    const result = await withRateLimit('solo', { minIntervalMs: 50 }, async () => 'done');

    expect(result).toBe('done');
    expect(Date.now() - started).toBeLessThan(40);
  });

  it('spaces successive calls by the minimum interval', async () => {
    const times: number[] = [];
    const start = Date.now();

    await Promise.all(
      [0, 1, 2].map(() =>
        withRateLimit('spaced', { minIntervalMs: 40 }, async () => {
          times.push(Date.now() - start);
        }),
      ),
    );

    times.sort((a, b) => a - b);
    // Three calls at 40ms spacing: roughly 0, 40, 80.
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(30);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(30);
  });

  it('caps how many calls are in flight at once', async () => {
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        withRateLimit('capped', { maxConcurrent: 2 }, async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 15));
          active -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('serialises a provider limited to one call at a time', async () => {
    const order: string[] = [];

    await Promise.all(
      ['a', 'b', 'c'].map((label) =>
        withRateLimit('serial', { maxConcurrent: 1 }, async () => {
          order.push(`start-${label}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`end-${label}`);
        }),
      ),
    );

    // No call may start before the previous one has ended.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).toMatch(/^start-/);
      expect(order[i + 1]).toMatch(/^end-/);
    }
  });

  it('keeps separate providers independent', async () => {
    let slowDone = false;

    const slow = withRateLimit('slow-provider', { maxConcurrent: 1 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      slowDone = true;
    });

    // A different provider must not queue behind an unrelated one.
    await withRateLimit('fast-provider', { maxConcurrent: 1 }, async () => {});
    expect(slowDone).toBe(false);

    await slow;
  });

  it('releases the slot when a call throws', async () => {
    await expect(
      withRateLimit('throwing', { maxConcurrent: 1 }, async () => {
        throw new Error('provider exploded');
      }),
    ).rejects.toThrow('provider exploded');

    // The gate must not be left holding a slot, or the provider deadlocks.
    await expect(
      withRateLimit('throwing', { maxConcurrent: 1 }, async () => 'recovered'),
    ).resolves.toBe('recovered');
  });

  it('propagates the resolved value unchanged', async () => {
    const payload = { candidates: [1, 2, 3] };
    await expect(withRateLimit('passthrough', {}, async () => payload)).resolves.toBe(payload);
  });
});

describe('provider limits', () => {
  it('serialises the keyless UPCitemdb trial tier', async () => {
    const { upcItemDbProvider } = await import('@/server/providers/search/barcode');

    // The trial allows ~100 lookups a day, so it must never be hit in parallel.
    expect(upcItemDbProvider.rateLimit?.maxConcurrent).toBe(1);
    expect(upcItemDbProvider.rateLimit?.minIntervalMs).toBeGreaterThan(0);
  });

  it('bounds OpenAI browsing calls', async () => {
    const { openAiWebProvider } = await import('@/server/providers/search/openai-web');
    expect(openAiWebProvider.rateLimit?.maxConcurrent).toBeGreaterThan(0);
    expect(openAiWebProvider.rateLimit?.maxConcurrent).toBeLessThanOrEqual(8);
  });
});
