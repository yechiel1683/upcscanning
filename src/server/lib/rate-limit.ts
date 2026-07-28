/**
 * Outbound rate limiting.
 *
 * Bulk processing is exactly the workload that gets an account throttled: a
 * batch of 1,000 products with eight workers will fire eight simultaneous
 * lookups at a free tier that allows a hundred *per day*, burn the quota in
 * seconds, and then take 429s for the rest of the run.
 *
 * Each provider declares how hard it may be pushed, and every call goes through
 * a gate that enforces both a minimum spacing between requests and a ceiling on
 * how many may be in flight at once.
 *
 * Scope: this limiter is per process. Running four worker containers means four
 * limiters, so the effective global rate is the configured rate times the number
 * of workers. The per-provider defaults below are set conservatively with that
 * in mind, and the lookup cache does the heavy lifting for the tightest quota
 * (UPCitemdb's trial tier). A cross-process limiter would need Redis, which is
 * optional in this deployment.
 */

export interface RateLimitConfig {
  /** Minimum milliseconds between the start of two calls. */
  minIntervalMs?: number;
  /** Maximum calls in flight at once. */
  maxConcurrent?: number;
}

interface GateState {
  config: Required<RateLimitConfig>;
  /** When the next call is allowed to start. */
  nextAvailableAt: number;
  active: number;
  waiting: Array<() => void>;
}

const gates = new Map<string, GateState>();

function gateFor(key: string, config: RateLimitConfig): GateState {
  let gate = gates.get(key);
  if (!gate) {
    gate = {
      config: {
        minIntervalMs: config.minIntervalMs ?? 0,
        maxConcurrent: config.maxConcurrent ?? Number.MAX_SAFE_INTEGER,
      },
      nextAvailableAt: 0,
      active: 0,
      waiting: [],
    };
    gates.set(key, gate);
  }
  return gate;
}

/**
 * Run `fn` under the named provider's rate limit.
 *
 * Callers queue rather than fail: a throttled lookup that arrives late is far
 * better than a product that fails because its provider was busy.
 */
export async function withRateLimit<T>(
  key: string,
  config: RateLimitConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const gate = gateFor(key, config);

  // Wait for a concurrency slot.
  if (gate.active >= gate.config.maxConcurrent) {
    await new Promise<void>((resolve) => gate.waiting.push(resolve));
  }
  gate.active += 1;

  try {
    // Wait for the spacing window, and claim it before awaiting so concurrent
    // callers space out rather than all reading the same timestamp.
    const now = Date.now();
    const startAt = Math.max(now, gate.nextAvailableAt);
    gate.nextAvailableAt = startAt + gate.config.minIntervalMs;

    const delay = startAt - now;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));

    return await fn();
  } finally {
    gate.active -= 1;
    const next = gate.waiting.shift();
    if (next) next();
  }
}

/** Test hook: forget all gate state. */
export function resetRateLimits(): void {
  gates.clear();
}

/** Introspection for the dashboard and tests. */
export function rateLimitState(key: string): { active: number; queued: number } | null {
  const gate = gates.get(key);
  return gate ? { active: gate.active, queued: gate.waiting.length } : null;
}
