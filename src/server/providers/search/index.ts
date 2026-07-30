import { Prisma } from '@prisma/client';

import { env } from '@/lib/env';
import { mergeFacts, type ProductFacts, type SearchCandidate } from '@/lib/types';
import { prisma } from '@/server/db';
import { withRateLimit } from '@/server/lib/rate-limit';
import { Memo } from '@/server/lib/memo';
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
  /** Providers that actually contributed something. */
  providers: string[];
  /** True when this came from the shared cache rather than the network. */
  cached?: boolean;
}

/** Run a provider's search under its declared rate limit. */
function runProvider(provider: SearchProvider, context: SearchContext) {
  if (!provider.rateLimit) return provider.search(context);
  return withRateLimit(provider.name, provider.rateLimit, () => provider.search(context));
}

/**
 * Resolve a barcode to product facts and any images the databases hold.
 *
 * Unlike the web tier this does not stop at the first hit: a second database
 * often fills in a model number or category the first one lacked, and the
 * lookups are cheap.
 *
 * They also all run at once. Every one of them is a request to a different host
 * keyed on the same GTIN, so none can inform another and asking them in turn
 * only adds up their latencies — which, for five databases, was most of the
 * time a user spent waiting for a barcode they had just typed. Concurrently the
 * tier costs one round trip instead of five.
 *
 * The results are then merged in the providers' declared order rather than in
 * whatever order the network returned them, so the same barcode resolves to the
 * same product every time.
 */
export async function lookupBarcode(context: SearchContext): Promise<TierResult> {
  return lookupBarcodeWith(
    availableProviders('barcode').filter((provider) => provider.supports(context)),
    context,
  );
}

/** The tier itself, over an explicit provider list, so the fan-out is testable. */
export async function lookupBarcodeWith(
  usable: SearchProvider[],
  context: SearchContext,
): Promise<TierResult> {
  const candidates: SearchCandidate[] = [];
  const errors: Array<{ provider: string; message: string }> = [];
  const facts: Array<ProductFacts | undefined> = [];
  const providers: string[] = [];
  const seen = new Set<string>();

  const settled = await Promise.all(
    usable.map(async (provider) => {
      try {
        return {
          provider,
          result: await runProvider(provider, { ...context, limit: context.limit }),
          error: null,
        };
      } catch (error) {
        return { provider, result: null, error };
      }
    }),
  );

  for (const { provider, result, error } of settled) {
    if (error || !result) {
      errors.push({
        provider: provider.name,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    facts.push(result.facts);
    if (result.facts || result.candidates.length > 0) providers.push(provider.name);
    for (const candidate of result.candidates) {
      const key = candidate.sourceUrl.split('?')[0] ?? candidate.sourceUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  return {
    candidates: candidates.slice(0, Math.max(context.limit, 1)),
    facts: mergeFacts(facts),
    errors,
    providers,
  };
}

/**
 * Cache-backed barcode lookup.
 *
 * The same GTIN resolves to the same product forever, and supplier lists
 * overlap heavily — so the second time a barcode appears, anywhere on the
 * instance, it costs nothing. That is what makes the keyless tier (a ~100/day
 * allowance) usable for bulk work at all.
 *
 * Errors are never cached: a provider outage must not poison a barcode for
 * days. A genuine "no database knows this" *is* cached, but briefly.
 */
/**
 * In front of Postgres, and the only cache guest mode has.
 *
 * Without a database `readCache` throws on every call, is caught, and falls
 * through to a live lookup — so the same barcode typed twice cost two round
 * trips and two of a free tier's hundred daily lookups. That is both the wait
 * the second time and, once the day's allowance is gone, the reason a barcode
 * that resolved this morning resolves to nothing this afternoon.
 */
const recentLookups = new Memo<TierResult>({ ttlMs: 30 * 60_000, max: 500 });

/** Test hook: forget what this process has seen. */
export function resetLookupMemo(): void {
  recentLookups.clear();
}

export async function lookupBarcodeCached(context: SearchContext): Promise<TierResult> {
  const upc = context.upc;
  if (!upc || !env().LOOKUP_CACHE_ENABLED) return lookupBarcode(context);

  const remembered = recentLookups.get(upc);
  if (remembered) {
    // Still count it. The popularity figure is what says which barcodes are
    // worth keeping warm, and a front cache that answers silently would make
    // the most-asked-for codes look like the least.
    bumpHits(upc);
    return { ...remembered, cached: true };
  }

  const cached = await readCache(upc);
  if (cached) {
    recentLookups.set(upc, cached);
    return cached;
  }

  const fresh = await lookupBarcode(context);

  // A total provider failure looks identical to "not found" from here, so only
  // write the cache when at least one provider actually answered.
  const everyProviderFailed =
    fresh.errors.length > 0 && fresh.candidates.length === 0 && !fresh.facts;
  if (!everyProviderFailed) {
    recentLookups.set(upc, fresh);
    await writeCache(upc, fresh).catch((error) =>
      console.warn('[lookup-cache] write failed', error),
    );
  }

  return fresh;
}

/** Best-effort popularity counter; never block a lookup on it. */
function bumpHits(upc: string): void {
  void prisma.barcodeLookup
    .update({ where: { upc }, data: { hits: { increment: 1 } } })
    .catch(() => {});
}

async function readCache(upc: string): Promise<TierResult | null> {
  try {
    const row = await prisma.barcodeLookup.findUnique({ where: { upc } });
    if (!row || row.expiresAt < new Date()) return null;

    bumpHits(upc);

    return {
      candidates: (row.candidates as unknown as SearchCandidate[]) ?? [],
      facts: (row.facts as unknown as ProductFacts | null) ?? undefined,
      errors: [],
      providers: row.providers,
      cached: true,
    };
  } catch (error) {
    // A cache that is down must degrade to a live lookup, not an outage.
    console.warn('[lookup-cache] read failed', error);
    return null;
  }
}

async function writeCache(upc: string, result: TierResult): Promise<void> {
  const config = env();
  const miss = !result.facts && result.candidates.length === 0;

  // A miss is worth re-checking sooner: databases add products over time.
  const days = miss ? config.LOOKUP_CACHE_MISS_TTL_DAYS : config.LOOKUP_CACHE_TTL_DAYS;
  const expiresAt = new Date(Date.now() + days * 24 * 3600 * 1000);

  const data = {
    // Prisma distinguishes "SQL NULL" from "JSON null" on a nullable column.
    facts: (result.facts ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull,
    candidates: result.candidates as unknown as Prisma.InputJsonValue,
    providers: result.providers,
    miss,
    fetchedAt: new Date(),
    expiresAt,
  };

  await prisma.barcodeLookup.upsert({
    where: { upc },
    create: { upc, ...data },
    update: { ...data, hits: 0 },
  });
}

/**
 * Cache effectiveness, for the status endpoint. `saved` is the number of
 * provider calls the cache has avoided — the number that says whether this is
 * earning its keep.
 */
export async function lookupCacheStats(): Promise<{
  enabled: boolean;
  entries: number;
  saved: number;
}> {
  const enabled = env().LOOKUP_CACHE_ENABLED;
  if (!enabled) return { enabled, entries: 0, saved: 0 };

  try {
    const [entries, aggregate] = await Promise.all([
      prisma.barcodeLookup.count(),
      prisma.barcodeLookup.aggregate({ _sum: { hits: true } }),
    ]);
    return { enabled, entries, saved: aggregate._sum.hits ?? 0 };
  } catch {
    return { enabled, entries: 0, saved: 0 };
  }
}

/** Housekeeping: drop expired rows. Safe to call from a cron or by hand. */
export async function pruneLookupCache(): Promise<number> {
  const result = await prisma.barcodeLookup.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
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
  const contributed: string[] = [];
  const seen = new Set<string>();

  const providers: SearchProvider[] = [];
  if (options.directImageUrl) providers.push(directUrlProvider(options.directImageUrl));
  providers.push(...availableProviders('web'));

  for (const provider of providers) {
    if (candidates.length >= limit) break;
    if (!provider.supports(context)) continue;

    try {
      const result = await runProvider(provider, { ...context, limit: limit - candidates.length });
      facts.push(result.facts);
      if (result.facts || result.candidates.length > 0) contributed.push(provider.name);
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

  return { candidates, facts: mergeFacts(facts), errors, providers: contributed };
}
