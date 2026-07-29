import { handleError, ok } from '@/server/api/respond';
import { generationStatus } from '@/server/providers/generate';
import { understandingProvider } from '@/server/providers/llm/enrichment';
import { providerStatus } from '@/server/providers/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What this instance can actually do, stated before a batch runs.
 *
 * Discovering that nothing is configured by watching every product fail is a
 * miserable first experience, and the reason is identical for all of them: one
 * unset variable. Publishing capability up front turns that into a sentence
 * read before spending anything. It exposes only on/off flags, never keys.
 */
export function GET() {
  try {
    const search = providerStatus();
    const web = search.filter((provider) => provider.kind === 'web' && provider.configured);
    const barcode = search.filter((provider) => provider.kind === 'barcode' && provider.configured);
    const generation = generationStatus();
    const understanding = understandingProvider();

    return ok({
      barcodeLookup: { count: barcode.length, providers: barcode.map((p) => p.name) },
      webSearch: { enabled: web.length > 0, providers: web.map((p) => p.name) },
      generation: { enabled: generation.enabled, provider: generation.provider },
      identification: understanding.provider,
      // The single fact that decides whether this instance is fully set up.
      fullyConfigured: web.length > 0 && generation.enabled,
    });
  } catch (error) {
    return handleError(error);
  }
}
