import { prisma } from '@/server/db';

/**
 * Readiness. The strict counterpart to /api/health: 503 unless the service can
 * actually do its job, which here means reaching the database.
 *
 * Point a load balancer at this when you want traffic withheld from a degraded
 * instance. Do not point a platform *deploy* healthcheck at it — a dependency
 * that is briefly slow to come up would fail the deploy rather than recover.
 */
export async function GET() {
  const database = await prisma
    .$queryRaw`SELECT 1`
    .then(() => true)
    .catch(() => false);

  return Response.json(
    {
      status: database ? 'ready' : 'not-ready',
      database,
      uptimeSeconds: Math.round(process.uptime()),
    },
    { status: database ? 200 : 503 },
  );
}
