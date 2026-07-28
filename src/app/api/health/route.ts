/**
 * Liveness. Answers exactly one question: is this process serving HTTP?
 *
 * It deliberately touches nothing. An earlier version queried the database
 * here, which is worse than useless: when the database host is unreachable the
 * query does not fail, it *hangs* on a TCP timeout, so the probe never responds
 * at all and the platform waits out its entire healthcheck window before
 * reporting an unexplained "Healthcheck failure". A liveness probe that can
 * block on a dependency is not a liveness probe.
 *
 * Dependency state lives in /api/health/ready, which is bounded by its own
 * timeout and is the right target for a load balancer — not for a deploy gate.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  });
}
