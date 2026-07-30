import { handleError, ok } from '@/server/api/respond';
import { generationStatus } from '@/server/providers/generate';
import { understandingProvider } from '@/server/providers/llm/enrichment';
import { providerStatus } from '@/server/providers/search';
import { buildSetupReport } from '@/server/setup/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Why this instance is not configured, as opposed to whether it is.
 *
 * Reports names, counts and shapes only — never a value. The one thing it will
 * say about a secret is how many characters long it is, which is enough to spot
 * a truncated paste and useless to anyone else.
 */
export function GET() {
  try {
    const report = buildSetupReport();
    const search = providerStatus();
    const web = search.filter((p) => p.kind === 'web' && p.configured);
    const barcode = search.filter((p) => p.kind === 'barcode' && p.configured);
    const generation = generationStatus();

    return ok({
      // Which build is actually serving. Without this, "is the fix live yet?"
      // is unanswerable from the outside, and a screenshot of an old build is
      // indistinguishable from a fix that did not work.
      build: {
        commit: (process.env.RAILWAY_GIT_COMMIT_SHA ?? '').slice(0, 7) || 'unknown',
        startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
      },
      checks: report.checks,
      keyLooksValid: report.keyLooksValid,
      capabilities: {
        barcodeLookup: { count: barcode.length, providers: barcode.map((p) => p.name) },
        webSearch: { enabled: web.length > 0, providers: web.map((p) => p.name) },
        generation: { enabled: generation.enabled, provider: generation.provider },
        identification: understandingProvider().provider,
        fullyConfigured: web.length > 0 && generation.enabled,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
