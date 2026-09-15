/**
 * Inbound rate limiting — refusing requests, not queueing them.
 *
 * This is the opposite of the outbound limiter next door. That one makes *our*
 * calls wait so a provider does not throttle us, because a lookup that arrives
 * late is better than a product that fails. This one turns strangers away,
 * because a request that arrives late is exactly as expensive as one that
 * arrives on time, and the thing being protected is a metered API budget.
 *
 * The hole it closes: `/api/guest/batches` is public, unauthenticated, and
 * accepts a hundred products per call. Every one of those spends real money on
 * search, vision verification and rendering. Nothing stopped a script from
 * calling it in a loop, and the first anyone would have known is a billing
 * alert the next morning.
 *
 * Sliding window rather than fixed buckets: a fixed window resets on a clock
 * edge, so a caller gets the whole allowance twice in quick succession by
 * arriving just before and just after the boundary. Timestamps cost a little
 * more memory and do not have that seam.
 *
 * Scope: per process. Two web containers means two limiters and twice the
 * effective allowance, so the ceilings here are set with that in mind and the
 * spend ceiling in `guest/budget.ts` — which is about money rather than
 * traffic — is the backstop that does not care how many processes there are.
 */

interface Window {
  /** Request times in this window, oldest first. */
  hits: number[];
  /** When this entry may be dropped, refreshed on every use. */
  expiresAt: number;
}

export interface RateLimitRule {
  /** How many requests are allowed in the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** Seconds until the caller may retry, when refused. */
  retryAfterSeconds: number;
  limit: number;
}

/**
 * Ceiling on tracked keys.
 *
 * Every distinct IP creates an entry, so an attacker spraying forged
 * `x-forwarded-for` values could otherwise turn the limiter itself into the
 * memory exhaustion it exists to prevent. At the cap the oldest entries go
 * first; being evicted only means a caller starts a fresh window, which is the
 * pre-existing behaviour rather than a new weakness.
 */
const MAX_TRACKED_KEYS = 20_000;

const windows = new Map<string, Window>();

/**
 * How far down to cut when the cap is hit.
 *
 * Trimming to exactly the cap would mean the expensive path runs again on the
 * very next request — an O(n log n) sort per call, during a flood, which is
 * precisely when this code must be cheap. Cutting back to four fifths amortises
 * it to roughly one sort per four thousand new callers.
 */
const LOW_WATER = Math.floor(MAX_TRACKED_KEYS * 0.8);

/**
 * Make room for one more entry.
 *
 * Called before inserting, so the test is `>=`: sweeping down *to* the cap and
 * then adding one puts the map over it, and a ceiling that is never actually
 * enforced is the bug this function exists to prevent.
 */
function sweep(now: number): void {
  if (windows.size < MAX_TRACKED_KEYS) {
    // Cheap path: only pay for a scan when there is pressure.
    return;
  }

  for (const [key, window] of windows) {
    if (window.expiresAt <= now) windows.delete(key);
  }
  if (windows.size < MAX_TRACKED_KEYS) return;

  // Still full of live entries: drop the ones that expire soonest, which are
  // the least recently active.
  const byAge = [...windows.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of byAge.slice(0, Math.max(1, windows.size - LOW_WATER))) {
    windows.delete(key);
  }
}

/**
 * Record a request against `key` and say whether it is allowed.
 *
 * A refused request is *not* recorded. Counting it would mean a caller who
 * keeps hammering a closed door never gets back in, turning a rate limit into
 * an indefinite ban — and the retry-after we hand out would be a lie.
 */
export function checkRate(key: string, rule: RateLimitRule, now = Date.now()): RateLimitVerdict {
  sweep(now);

  const cutoff = now - rule.windowMs;
  const window = windows.get(key);
  const hits = window ? window.hits.filter((time) => time > cutoff) : [];

  if (hits.length >= rule.limit) {
    const oldest = hits[0] ?? now;
    // Keep the trimmed list so the next call does not re-filter the same
    // expired entries, but do not add this refusal to it.
    windows.set(key, { hits, expiresAt: now + rule.windowMs });
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)),
      limit: rule.limit,
    };
  }

  hits.push(now);
  windows.set(key, { hits, expiresAt: now + rule.windowMs });

  return {
    allowed: true,
    remaining: rule.limit - hits.length,
    retryAfterSeconds: 0,
    limit: rule.limit,
  };
}

/**
 * How many requests `key` has left, without spending one.
 *
 * For handlers that need to know before doing work they cannot undo.
 */
export function peekRate(key: string, rule: RateLimitRule, now = Date.now()): number {
  const cutoff = now - rule.windowMs;
  const hits = windows.get(key)?.hits.filter((time) => time > cutoff) ?? [];
  return Math.max(0, rule.limit - hits.length);
}

/** Test hook: forget every window. */
export function resetRateLimits(): void {
  windows.clear();
}

/** Diagnostics: how many distinct callers are currently tracked. */
export function trackedKeyCount(): number {
  return windows.size;
}
