import type { SearchCandidate } from '@/lib/types';
import { goUpcProvider, openFoodFactsProvider, upcItemDbProvider } from './barcode';
import type { SearchContext, SearchProvider } from './types';
import { bingImageProvider, directUrlProvider, googleCseProvider, serpApiProvider } from './web';

export type { SearchContext, SearchProvider } from './types';
export { directUrlProvider, isTrustedRetailer } from './web';

/**
 * Ordered by trust. The pipeline walks this list and stops early once it has a
 * confident match, so the cheap, exact sources must come first.
 */
const REGISTRY: SearchProvider[] = [
  upcItemDbProvider,
  goUpcProvider,
  openFoodFactsProvider,
  serpApiProvider,
  googleCseProvider,
  bingImageProvider,
];

export function availableProviders(): SearchProvider[] {
  return REGISTRY.filter((provider) => provider.isConfigured());
}

/** Names of every provider that could run, for the dashboard's status panel. */
export function providerStatus(): Array<{ name: string; configured: boolean; kind: string }> {
  return REGISTRY.map((provider) => ({
    name: provider.name,
    configured: provider.isConfigured(),
    kind: provider.baseConfidence >= 0.85 ? 'barcode' : 'web',
  }));
}

export interface GatherOptions {
  /** Include this URL as the first candidate (the spreadsheet's own column). */
  directImageUrl?: string | null;
  /** Stop gathering once this many candidates are collected. */
  limit?: number;
}

/**
 * Collect candidates across providers.
 *
 * Providers are queried in trust order rather than in parallel: a barcode hit
 * usually ends the search, and skipping the paid web-search calls for those
 * rows is the difference between a viable unit cost and an unviable one on a
 * 1,000-product batch.
 */
export async function gatherCandidates(
  context: SearchContext,
  options: GatherOptions = {},
): Promise<{ candidates: SearchCandidate[]; errors: Array<{ provider: string; message: string }> }> {
  const limit = options.limit ?? context.limit;
  const candidates: SearchCandidate[] = [];
  const errors: Array<{ provider: string; message: string }> = [];
  const seenUrls = new Set<string>();

  const providers: SearchProvider[] = [];
  if (options.directImageUrl) providers.push(directUrlProvider(options.directImageUrl));
  providers.push(...availableProviders());

  for (const provider of providers) {
    if (candidates.length >= limit) break;
    if (!provider.supports(context)) continue;

    try {
      const found = await provider.search({ ...context, limit: limit - candidates.length });
      for (const candidate of found) {
        const key = candidate.sourceUrl.split('?')[0] ?? candidate.sourceUrl;
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        candidates.push(candidate);
      }
    } catch (error) {
      errors.push({
        provider: provider.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { candidates, errors };
}
