import { randomBytes } from 'node:crypto';

import { env } from '@/lib/env';
import { prisma } from '@/server/db';
import { connectionOptions } from '@/server/queue';
import { storage } from '@/server/storage';

/**
 * Is this instance actually able to do its job?
 *
 * The account half of this product has three dependencies it cannot fake —
 * a database, a queue, and somewhere to put rendered images — and each one
 * fails in a way that looks like something else from the outside. A missing
 * bucket does not announce itself; it surfaces as batches that process happily
 * and then 404 when someone clicks the picture. A Redis URL pointing at
 * nothing means jobs queue forever and every batch sits at "processing".
 *
 * So each dependency is probed for what it is actually used for, and each
 * answer says what to change rather than reporting a boolean.
 *
 * Every probe is bounded. An unreachable host does not refuse a connection, it
 * swallows it, which is how a health check becomes a hung request rather than
 * an answer — and a hung health check reads as a dead app.
 */

const PROBE_TIMEOUT_MS = 3000;

export interface ProbeResult {
  name: string;
  ok: boolean;
  /** Present tense, and specific enough to act on. */
  detail: string;
  /** False when this dependency is not configured, so not a failure. */
  configured: boolean;
}

/** Run a probe, or give up on it, whichever happens first. */
async function bounded(
  name: string,
  work: () => Promise<ProbeResult>,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          name,
          ok: false,
          configured: true,
          detail: `no response within ${timeoutMs}ms — the host is probably unreachable rather than busy`,
        }),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([work(), timeout]);
  } catch (error) {
    return { name, ok: false, configured: true, detail: describe(error) };
  } finally {
    clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return 'failed';
  // Prisma and ioredis both put the useful sentence first and a stack of
  // context after it.
  return error.message.split('\n')[0] ?? 'failed';
}

export function probeDatabase(): Promise<ProbeResult> {
  return bounded('database', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { name: 'database', ok: true, configured: true, detail: 'connected' };
  });
}

/**
 * The queue, probed by actually talking to Redis.
 *
 * With the inline driver there is no Redis and nothing to check — jobs run in
 * the web process. That is a legitimate configuration for a small deployment,
 * so it reports as not-configured rather than as a failure, with the caveat
 * stated: a restart loses whatever was in flight.
 */
export function probeQueue(): Promise<ProbeResult> {
  return bounded('queue', async () => {
    if (env().QUEUE_DRIVER !== 'redis') {
      return {
        name: 'queue',
        ok: true,
        configured: false,
        detail:
          'running inline in the web process — fine for low volume, but a restart ' +
          'loses jobs in flight. Set QUEUE_DRIVER=redis and REDIS_URL for a real queue.',
      };
    }

    const { default: IORedis } = await import('ioredis');
    const client = new IORedis({
      ...connectionOptions(),
      // Fail rather than reconnect forever: this is a health check, and an
      // endlessly retrying client is how it hangs.
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
      connectTimeout: PROBE_TIMEOUT_MS,
    });

    try {
      await client.connect();
      const pong = await client.ping();
      return {
        name: 'queue',
        ok: pong === 'PONG',
        configured: true,
        detail: pong === 'PONG' ? 'redis responding' : `unexpected reply: ${pong}`,
      };
    } finally {
      // Always, or a failed probe leaks a socket on every call.
      client.disconnect();
    }
  });
}

/**
 * Storage, probed by a real round trip.
 *
 * Credentials that authenticate but cannot write are the failure that matters
 * here, and nothing short of writing something detects it. The object is tiny,
 * uniquely named so two instances probing at once cannot collide, and deleted
 * afterwards — but the write is the point, so this is not run on every routine
 * health check.
 */
export function probeStorage(): Promise<ProbeResult> {
  return bounded('storage', async () => {
    const driver = storage();
    const key = `health/probe-${randomBytes(8).toString('hex')}.txt`;
    const payload = Buffer.from('ok');

    await driver.put(key, payload, 'text/plain');
    try {
      const read = await driver.get(key);
      if (!read.equals(payload)) {
        return {
          name: 'storage',
          ok: false,
          configured: true,
          detail: `${driver.name}: wrote ${payload.byteLength} bytes and read back ${read.byteLength}`,
        };
      }
      return {
        name: 'storage',
        ok: true,
        configured: true,
        detail: `${driver.name}: wrote, read and deleted a test object`,
      };
    } finally {
      // A probe object left behind on every check is litter that accumulates
      // in a bucket nobody looks at.
      await driver.delete(key).catch(() => {});
    }
  });
}

export interface Readiness {
  ready: boolean;
  probes: ProbeResult[];
}

/**
 * `deep` adds the storage round trip. Routine checks leave it out so a
 * platform polling every few seconds is not writing an object every time.
 */
export async function checkReadiness(deep = false): Promise<Readiness> {
  const probes = await Promise.all([
    probeDatabase(),
    probeQueue(),
    ...(deep ? [probeStorage()] : []),
  ]);

  // A dependency that is deliberately not configured does not make the
  // instance unready — an inline queue is a choice, not a fault.
  return { ready: probes.every((probe) => probe.ok), probes };
}
