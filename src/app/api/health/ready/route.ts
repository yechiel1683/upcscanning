import { checkReadiness } from '@/server/health/probes';

/**
 * Readiness: can this instance actually do its job?
 *
 * Distinct from `/api/health`, which answers "is the process alive" and is what
 * the platform polls. This one asks the harder question, and answers it per
 * dependency — because "not ready" on its own sends an operator looking through
 * logs for something the check already knew.
 *
 * `?deep=1` adds a real write-read-delete against storage. Left out of the
 * routine answer so a platform polling every few seconds is not writing an
 * object each time; worth running by hand after changing storage settings,
 * since credentials that authenticate but cannot write look identical to
 * working ones until the first customer clicks an image.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get('deep') === '1';
  const { ready, probes } = await checkReadiness(deep);

  return Response.json(
    {
      status: ready ? 'ready' : 'not-ready',
      uptimeSeconds: Math.round(process.uptime()),
      checks: Object.fromEntries(
        probes.map((probe) => [
          probe.name,
          { ok: probe.ok, configured: probe.configured, detail: probe.detail },
        ]),
      ),
      // Named plainly so an operator reading a 503 in a terminal knows where to
      // go without opening the dashboard.
      blocking: probes.filter((probe) => !probe.ok).map((probe) => probe.name),
    },
    { status: ready ? 200 : 503 },
  );
}
