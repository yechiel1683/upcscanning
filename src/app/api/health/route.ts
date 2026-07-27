import { prisma } from '@/server/db';

/** Liveness/readiness probe. Reports degraded rather than failing outright. */
export async function GET() {
  const database = await prisma
    .$queryRaw`SELECT 1`
    .then(() => true)
    .catch(() => false);

  return Response.json(
    { status: database ? 'ok' : 'degraded', database, uptimeSeconds: Math.round(process.uptime()) },
    { status: database ? 200 : 503 },
  );
}
