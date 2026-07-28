import { prisma } from '@/server/db';

/**
 * Shown on the sign-in and sign-up pages when the database is unreachable.
 *
 * Without this, a deployment with no database attached looks like a working
 * site whose sign-up button is broken — the form submits, fails, and says "try
 * again", which is both untrue and unactionable. The failure is in the
 * infrastructure, so it belongs on the screen, not only in a log nobody has
 * opened.
 */

const PROBE_TIMEOUT_MS = 2500;

async function databaseReachable(): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Bounded: an unreachable host swallows connections rather than refusing
    // them, and this runs while somebody is waiting for a page.
    return await Promise.race([
      prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function SetupBanner() {
  if (await databaseReachable()) return null;

  return (
    <div
      role="alert"
      className="mb-5 rounded-xl border border-warning/40 bg-warning-soft p-4 text-sm"
    >
      <p className="font-semibold text-fg">This instance has no database yet</p>
      <p className="mt-1.5 leading-relaxed text-muted">
        Accounts cannot be created until one is connected. This is a setup step, not a
        problem with your details.
      </p>
      <ol className="mt-3 space-y-1 text-muted">
        <li>1. Add a PostgreSQL database to this project.</li>
        <li>
          2. Set{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">
            DATABASE_URL
          </code>{' '}
          on this service to point at it.
        </li>
        <li>3. Redeploy — the tables are created automatically on start.</li>
      </ol>
    </div>
  );
}
