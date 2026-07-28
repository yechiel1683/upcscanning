import 'dotenv/config';

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { inspectConfiguration, reportConfiguration } from '@/server/preflight';

/**
 * Pre-start release step: apply migrations, then report configuration.
 *
 * The deployed service is useless without its schema — every request that
 * touches the database returns a 500 while the build and the container both
 * look perfectly healthy. `migrate deploy` is idempotent, so running it on
 * every boot is safe and removes a manual step nobody remembers.
 *
 * Prisma takes an advisory lock, so simultaneous replicas will not race each
 * other; the losers wait, find nothing pending, and exit.
 */

/**
 * Connecting is retried because a container usually starts faster than the
 * network it depends on. On Railway the private DNS name of the database
 * (`*.railway.internal`) is not resolvable for the first few seconds of a
 * container's life, so the very first connection attempt loses a race it was
 * never going to win — and the container dies before it can serve anything.
 */
const CONNECT_ATTEMPTS = 6;
const BACKOFF_MS = [1000, 2000, 4000, 6000, 8000, 8000];

/** Failures that mean "not reachable yet" rather than "wrong". */
function looksTransient(output: string): boolean {
  return /P1001|P1002|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|Timed out|connection refused/i.test(
    output,
  );
}

async function migrate(): Promise<number> {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
      encoding: 'utf8',
    });

    if (result.error) {
      console.error('[release] could not run prisma:', result.error.message);
      return 1;
    }

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);

    if ((result.status ?? 1) === 0) return 0;

    // A real migration error will not fix itself; fail fast and loudly.
    if (!looksTransient(output)) return result.status ?? 1;

    if (attempt < CONNECT_ATTEMPTS) {
      const wait = BACKOFF_MS[attempt - 1] ?? 8000;
      console.log(
        `[release] database not reachable yet (attempt ${attempt}/${CONNECT_ATTEMPTS}); ` +
          `retrying in ${wait / 1000}s — private networking can take a moment to come up`,
      );
      await sleep(wait);
    }
  }

  return 1;
}

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error(
      '[release] DATABASE_URL is not set. The app cannot start without a database.\n' +
        '[release] On Railway: add a Postgres service, then set this service\'s\n' +
        '[release] DATABASE_URL variable to ${{Postgres.DATABASE_URL}}.',
    );
    return 1;
  }

  console.log('[release] applying database migrations…');
  const status = await migrate();

  if (status !== 0) {
    console.error(
      '\n[release] ────────────────────────────────────────────────────────────\n' +
        '[release] MIGRATIONS FAILED — not starting the server.\n' +
        '[release]\n' +
        '[release] Serving requests against a missing or partial schema would\n' +
        '[release] return an error on every page, so this stops instead.\n' +
        '[release]\n' +
        '[release] Check, in order:\n' +
        '[release]   1. A Postgres service exists and is running.\n' +
        '[release]   2. DATABASE_URL on THIS service references it, e.g.\n' +
        '[release]      ${{Postgres.DATABASE_URL}}\n' +
        '[release]   3. That user may create tables.\n' +
        '[release] ────────────────────────────────────────────────────────────',
    );
    return status;
  }

  console.log('[release] migrations are up to date');

  // Warnings are advisory; anything fatal stops the boot rather than shipping a
  // service that looks healthy and loses data.
  if (!reportConfiguration(inspectConfiguration())) {
    console.error('[release] refusing to start with a fatal configuration problem (see above)');
    return 1;
  }

  return 0;
}

main().then((code) => process.exit(code));
