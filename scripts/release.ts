import 'dotenv/config';

import { spawnSync } from 'node:child_process';

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

function main(): number {
  if (!process.env.DATABASE_URL) {
    console.error(
      '[release] DATABASE_URL is not set. The app cannot start without a database.\n' +
        '[release] On Railway: add a Postgres service, then reference its connection\n' +
        '[release] string from this service as DATABASE_URL.',
    );
    return 1;
  }

  console.log('[release] applying database migrations…');
  const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });

  if (result.error) {
    console.error('[release] could not run prisma:', result.error.message);
    return 1;
  }

  if ((result.status ?? 1) !== 0) {
    console.error(
      '\n[release] migrations failed, so the service is NOT starting — it would return\n' +
        '[release] an error on every request against a missing or partial schema.\n' +
        '[release] Check that DATABASE_URL is reachable and its user may create tables.',
    );
    return result.status ?? 1;
  }

  console.log('[release] migrations are up to date');

  // Warnings are advisory; anything fatal stops the boot rather than shipping a
  // service that looks healthy and loses data.
  const ok = reportConfiguration(inspectConfiguration());
  if (!ok) {
    console.error('[release] refusing to start with a fatal configuration problem (see above)');
    return 1;
  }

  return 0;
}

process.exit(main());
