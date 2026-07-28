import { prisma } from '@/server/db';

/**
 * Liveness. Answers one question: is this process serving HTTP?
 *
 * It deliberately returns 200 even when the database is unreachable. A platform
 * healthcheck decides whether to keep a container in rotation, and a brief
 * database blip should not tear down a web server that is otherwise fine — that
 * turns a recoverable dependency outage into a restart loop, and reports it as
 * the opaque "Healthcheck failure" that gives no clue what broke.
 *
 * The database's actual state is in the body, and /api/health/ready is the
 * strict version for anything that needs to gate on it.
 */
export async function GET() {
  const database = await prisma
    .$queryRaw`SELECT 1`
    .then(() => true)
    .catch(() => false);

  return Response.json({
    status: database ? 'ok' : 'degraded',
    database,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
