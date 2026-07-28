import 'dotenv/config';

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { inspectConfiguration, reportConfiguration } from '@/server/preflight';

/**
 * Pre-start release step: apply migrations, then report configuration.
 *
 * `migrate deploy` is idempotent, so running it on every boot is safe and
 * removes a manual step nobody remembers. Prisma takes an advisory lock, so
 * simultaneous replicas will not race each other.
 *
 * On failure this warns and starts the server anyway, which is a deliberate
 * reversal. Refusing to boot sounds responsible, but the only thing a platform
 * reports when a container never serves is "Healthcheck failure" — no cause, no
 * logs on the deployment screen, nothing to act on. Starting means the operator
 * gets a running app that says exactly what is wrong, on a page and in the
 * logs, instead of a red X with no explanation.
 */

/**
 * Connecting is retried because a container usually starts faster than the
 * network it depends on. On Railway the private DNS name of the database
 * (`*.railway.internal`) is not resolvable for the first few seconds of a
 * container's life.
 */
const CONNECT_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 6000, 8000];

/** Failures that mean "not reachable yet" rather than "wrong". */
function looksTransient(output: string): boolean {
  return /P1001|P1002|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|Timed out|connection refused/i.test(
    output,
  );
}

function banner(lines: string[]): void {
  const width = 68;
  console.error('');
  console.error(`┌${'─'.repeat(width)}┐`);
  for (const line of lines) console.error(`│ ${line.padEnd(width - 2)} │`);
  console.error(`└${'─'.repeat(width)}┘`);
  console.error('');
}

async function migrate(): Promise<{ ok: boolean; reason?: string }> {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { encoding: 'utf8' });

    if (result.error) return { ok: false, reason: result.error.message };

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);

    if ((result.status ?? 1) === 0) return { ok: true };

    // A real migration error will not fix itself; stop retrying immediately.
    if (!looksTransient(output)) {
      return { ok: false, reason: 'a migration failed to apply (see the output above)' };
    }

    if (attempt < CONNECT_ATTEMPTS) {
      const wait = BACKOFF_MS[attempt - 1] ?? 8000;
      console.log(
        `[release] database not reachable yet (attempt ${attempt}/${CONNECT_ATTEMPTS}); ` +
          `retrying in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }

  return { ok: false, reason: 'the database was not reachable after several attempts' };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    banner([
      'DATABASE_URL IS NOT SET',
      '',
      'The app is starting so you can reach it, but every page that',
      'needs data will fail until a database is connected.',
      '',
      'On Railway:',
      '  1. New → Database → Add PostgreSQL',
      '  2. Open THIS service → Variables → New Variable',
      '  3. DATABASE_URL = ${{Postgres.DATABASE_URL}}',
      '',
      'The app will apply its schema automatically on the next deploy.',
    ]);
    return;
  }

  console.log('[release] applying database migrations…');
  const result = await migrate();

  if (result.ok) {
    console.log('[release] migrations are up to date');
    reportConfiguration(inspectConfiguration());
    return;
  }

  banner([
    'DATABASE NOT READY — STARTING ANYWAY',
    '',
    `Reason: ${result.reason ?? 'unknown'}`,
    '',
    'The server is starting so the deployment succeeds and you can',
    'see this. Pages that need data will fail until it is fixed.',
    '',
    'Check, in order:',
    '  1. A Postgres service exists and is running.',
    '  2. DATABASE_URL on THIS service points at it:',
    '     DATABASE_URL = ${{Postgres.DATABASE_URL}}',
    '  3. That database user may create tables.',
    '',
    'Then redeploy — migrations run automatically on every boot.',
  ]);

  reportConfiguration(inspectConfiguration());
}

main()
  .catch((error) => {
    // Even an unexpected failure here must not stop the server from starting.
    console.error('[release] unexpected error:', error);
  })
  .finally(() => {
    console.log(
      `[release] starting server on port ${process.env.PORT ?? 3000} (host 0.0.0.0)`,
    );
  });
