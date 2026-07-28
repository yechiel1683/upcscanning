import { prisma } from '@/server/db';

/**
 * Readiness: can this instance actually do its job?
 *
 * The database probe is bounded. An unreachable host does not refuse a
 * connection, it swallows it, so an unguarded query can hang far longer than
 * any caller is willing to wait — which is precisely how a health endpoint
 * turns into a hung request instead of an answer.
 */
export const dynamic = 'force-dynamic';

const PROBE_TIMEOUT_MS = 3000;

async function probeDatabase(): Promise<{ ok: boolean; detail: string }> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<{ ok: false; detail: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, detail: `no response within ${PROBE_TIMEOUT_MS}ms` }),
      PROBE_TIMEOUT_MS,
    );
  });

  const query = prisma
    .$queryRaw`SELECT 1`
    .then(() => ({ ok: true, detail: 'connected' }))
    .catch((error: unknown) => ({
      ok: false,
      detail: error instanceof Error ? error.message.split('\n')[0] ?? 'query failed' : 'query failed',
    }));

  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const database = await probeDatabase();

  return Response.json(
    {
      status: database.ok ? 'ready' : 'not-ready',
      database: database.ok,
      databaseDetail: database.detail,
      uptimeSeconds: Math.round(process.uptime()),
    },
    { status: database.ok ? 200 : 503 },
  );
}
