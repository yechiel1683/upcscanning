import { mergeFacts, type ProductFacts, type SearchCandidate } from '@/lib/types';
import {
  goUpcProvider,
  openBeautyFactsProvider,
  openFoodFactsProvider,
  openPetFoodFactsProvider,
  openProductsFactsProvider,
  upcItemDbProvider,
} from './barcode';
import { openAiWebProvider } from './openai-web';
import type { ProviderTier, SearchContext, SearchProvider } from './types';
import { bingImageProvider, directUrlProvider, googleCseProvider, serpApiProvider } from './web';

export type { ProviderTier, SearchContext, SearchProvider } from './types';
export { directUrlProvider, isTrustedRetailer } from './web';

/**
 * The search tiers, each ordered by trust.
 *
 * Barcode providers run first and separately, because they answer a different
 * question: not "where is a picture" but "what is this thing". Their answer
 * feeds the web tier's queries, which is why a bare column of numbers can come
 * back with names, brands, models — and the right photograph.
 */
const BARCODE_PROVIDERS: SearchProvider[] = [
  upcItemDbProvider,
  goUpcProvider,
  openFoodFactsProvider,
  openBeautyFactsProvider,
  openProductsFactsProvider,
  openPetFoodFactsProvider,
];

const WEB_PROVIDERS: SearchProvider[] = [
  openAiWebProvider,
  serpApiProvider,
  googleCseProvider,
  bingImageProvider,
];

const ALL_PROVIDERS = [...BARCODE_PROVIDERS, ...WEB_PROVIDERS];

export function availableProviders(tier?: ProviderTier): SearchProvider[] {
  const pool = tier === 'barcode' ? BARCODE_PROVIDERS : tier === 'web' ? WEB_PROVIDERS : ALL_PROVIDERS;
  return pool.filter((provider) => provider.isConfigured());
}

/** Provider inventory for the dashboard's status panel. */
export function providerStatus(): Array<{
  name: string;
  configured: boolean;
  kind: ProviderTier;
  keyless: boolean;
}> {
  return ALL_PROVIDERS.map((provider) => ({
    name: provider.name,
    configured: provider.isConfigured(),
    kind: provider.tier,
    // The honest answer to "what do I get before I pay anyone".
    keyless: provider.keyless,
  }));
}

export interface TierResult {
  candidates: SearchCandidate[];
  facts?: ProductFacts;
  errors: Array<{ provider: string; message: string }>;
}

/**
 * Resolve a barcode to product facts and any images the databases hold.
 *
 * Unlike the web tier this does not stop at the first hit: a second database
 * often fills in a model number or category the first one lacked, and the
 * lookups are cheap.
 */
export async function lookupBarcode(context: SearchContext): Promise<TierResult> {
  const candidates: SearchCandidate[] = [];
  const errors: Array<{ provider: string; message: string }> = [];
  const facts: Array<ProductFacts | undefined> = [];
  const seen = new Set<string>();

  for (const provider of availableProviders('barcode')) {
    if (!provider.supports(context)) continue;
    // Once several databases agree and we have plenty of pictures, stop.
    if (candidates.length >= context.limit && facts.filter(Boolean).length >= 2) break;

    try {
      const result = await provider.search({ ...context, limit: context.limit });
      facts.push(result.facts);
      for (const candidate of result.candidates) {
        const key = candidate.sourceUrl.split('?')[0] ?? candidate.sourceUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    } catch (error) {
      errors.push({
        provider: provider.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { candidates, facts: mergeFacts(facts), errors };
}

export interface WebSearchOptions {
  /** Include this URL as the first candidate (the spreadsheet's own column). */
  directImageUrl?: string | null;
  limit?: number;
}

/** Search the open web for pictures. Stops as soon as it has enough. */
export async function searchWeb(
  context: SearchContext,
  options: WebSearchOptions = {},
): Promise<TierResult> {
  const limit = options.limit ?? context.limit;
  const candidates: SearchCandidate[] = [];
  const errors: Array<{ provider: string; message: string }> = [];
  const facts: Array<ProductFacts | undefined> = [];
  const seen = new Set<string>();

  const providers: SearchProvider[] = [];
  if (options.directImageUrl) providers.push(directUrlProvider(options.directImageUrl));
  providers.push(...availableProviders('web'));

  for (const provider of providers) {
    if (candidates.length >= limit) break;
    if (!provider.supports(context)) continue;

    try {
      const result = await provider.search({ ...context, limit: limit - candidates.length });
      facts.push(result.facts);
      for (const candidate of result.candidates) {
        const key = candidate.sourceUrl.split('?')[0] ?? candidate.sourceUrl;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    } catch (error) {
      errors.push({
        provider: provider.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { candidates, facts: mergeFacts(facts), errors };
}
