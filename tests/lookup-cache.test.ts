import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The cache is what makes the keyless tier usable in bulk: UPCitemdb's trial
 * allows roughly a hundred lookups a day, and supplier lists overlap heavily,
 * so answering the same barcode twice is pure waste.
 *
 * Prisma is faked here so these run without a database — what matters is the
 * decision logic (when to read, when to write, what never to cache), not
 * Postgres.
 */

interface CacheRow {
  upc: string;
  facts: unknown;
  candidates: unknown;
  providers: string[];
  miss: boolean;
  hits: number;
  fetchedAt: Date;
  expiresAt: Date;
}

const store = new Map<string, CacheRow>();

vi.mock('@/server/db', () => ({
  prisma: {
    barcodeLookup: {
      findUnique: vi.fn(async ({ where }: { where: { upc: string } }) => store.get(where.upc) ?? null),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { upc: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = store.get(where.upc);
          // Postgres applies the schema default on insert; mirror that here so
          // the counter starts at 0 rather than undefined.
          const row = (existing ? { ...existing, ...update } : { hits: 0, ...create }) as CacheRow;
          store.set(where.upc, row);
          return row;
        },
      ),
      update: vi.fn(async ({ where }: { where: { upc: string } }) => {
        const row = store.get(where.upc);
        if (row) row.hits += 1;
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        let count = 0;
        for (const [key, row] of store) {
          if (row.expiresAt < where.expiresAt.lt) {
            store.delete(key);
            count += 1;
          }
        }
        return { count };
      }),
    },
  },
}));

const searchSpy = vi.fn();

vi.mock('@/server/providers/search/barcode', async () => {
  const stub = (name: string) => ({
    name,
    tier: 'barcode' as const,
    baseConfidence: 0.95,
    keyless: true,
    isConfigured: () => name === 'upcitemdb',
    supports: (context: { upc?: string | null }) => Boolean(context.upc),
    search: (context: unknown) => searchSpy(context),
  });

  return {
    upcItemDbProvider: stub('upcitemdb'),
    goUpcProvider: stub('go-upc'),
    openFoodFactsProvider: stub('openfoodfacts'),
    openBeautyFactsProvider: stub('openbeautyfacts'),
    openProductsFactsProvider: stub('openproductsfacts'),
    openPetFoodFactsProvider: stub('openpetfoodfacts'),
  };
});

const { lookupBarcodeCached, pruneLookupCache, resetLookupMemo } = await import('@/server/providers/search');
const { resetEnvCache } = await import('@/lib/env');

const context = {
  upc: '036000291452',
  sku: null,
  name: 'Product 036000291452',
  brand: null,
  model: null,
  enrichment: {
    canonicalTitle: 'Product 036000291452',
    searchQueries: ['036000291452'],
    generationPrompt: '',
    negativeKeywords: [],
    requiredKeywords: [],
    source: 'heuristic' as const,
  },
  limit: 6,
};

const hit = {
  candidates: [
    { provider: 'upcitemdb', sourceUrl: 'https://cdn.example.com/aa.jpg', providerConfidence: 0.95 },
  ],
  facts: { title: 'Duracell Coppertop AA Batteries 8 Pack', brand: 'Duracell', source: 'upcitemdb' },
};

beforeEach(() => {
  store.clear();
  // The process-local cache in front of Postgres would otherwise answer from a
  // previous test, which is exactly what it is for and exactly wrong here.
  resetLookupMemo();
  searchSpy.mockReset();
  delete process.env.LOOKUP_CACHE_ENABLED;
  resetEnvCache();
});

afterEach(() => {
  resetEnvCache();
});

describe('lookupBarcodeCached', () => {
  it('calls the provider on a miss and serves the second lookup from cache', async () => {
    searchSpy.mockResolvedValue(hit);

    const first = await lookupBarcodeCached(context);
    expect(first.cached).toBeFalsy();
    expect(searchSpy).toHaveBeenCalledTimes(1);

    const second = await lookupBarcodeCached(context);
    expect(second.cached).toBe(true);
    expect(second.facts?.title).toBe('Duracell Coppertop AA Batteries 8 Pack');
    expect(second.candidates).toHaveLength(1);

    // The whole point: the network is untouched the second time.
    expect(searchSpy).toHaveBeenCalledTimes(1);
  });

  it('caches a genuine "no database knows this" so misses are not re-paid', async () => {
    searchSpy.mockResolvedValue({ candidates: [] });

    await lookupBarcodeCached(context);
    const second = await lookupBarcodeCached(context);

    expect(second.cached).toBe(true);
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(store.get('036000291452')?.miss).toBe(true);
  });

  it('expires a miss sooner than a hit, since databases add products later', async () => {
    searchSpy.mockResolvedValue({ candidates: [] });
    await lookupBarcodeCached(context);
    const missExpiry = store.get('036000291452')!.expiresAt.getTime();

    // Emptying the durable cache stands for a fresh instance, which would have
    // an empty front cache too.
    store.clear();
    resetLookupMemo();
    searchSpy.mockResolvedValue(hit);
    await lookupBarcodeCached(context);
    const hitExpiry = store.get('036000291452')!.expiresAt.getTime();

    expect(missExpiry).toBeLessThan(hitExpiry);
  });

  it('never caches a provider outage', async () => {
    searchSpy.mockRejectedValue(new Error('upstream 503'));

    const result = await lookupBarcodeCached(context);
    expect(result.errors).toHaveLength(1);
    // Caching this would blind the barcode for days over a transient failure.
    expect(store.size).toBe(0);

    searchSpy.mockResolvedValue(hit);
    const retry = await lookupBarcodeCached(context);
    expect(retry.facts?.brand).toBe('Duracell');
  });

  it('re-queries once an entry has expired', async () => {
    searchSpy.mockResolvedValue(hit);
    await lookupBarcodeCached(context);

    const row = store.get('036000291452')!;
    row.expiresAt = new Date(Date.now() - 1000);
    // These tests age an entry by rewriting its expiry rather than moving the
    // clock, which the process-local cache in front of Postgres cannot see.
    // Real elapsed time expires both.
    resetLookupMemo();

    await lookupBarcodeCached(context);
    expect(searchSpy).toHaveBeenCalledTimes(2);
  });

  it('counts cache hits so popular barcodes are visible', async () => {
    searchSpy.mockResolvedValue(hit);
    await lookupBarcodeCached(context);
    await lookupBarcodeCached(context);
    await lookupBarcodeCached(context);

    expect(store.get('036000291452')?.hits).toBe(2);
  });

  it('can be turned off entirely', async () => {
    process.env.LOOKUP_CACHE_ENABLED = 'false';
    resetEnvCache();
    searchSpy.mockResolvedValue(hit);

    await lookupBarcodeCached(context);
    await lookupBarcodeCached(context);

    expect(searchSpy).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it('skips the cache for a product with no barcode', async () => {
    searchSpy.mockResolvedValue({ candidates: [] });

    await lookupBarcodeCached({ ...context, upc: null });
    expect(store.size).toBe(0);
  });

  it('records which providers answered, for debugging a bad entry', async () => {
    searchSpy.mockResolvedValue(hit);
    await lookupBarcodeCached(context);

    expect(store.get('036000291452')?.providers).toEqual(['upcitemdb']);
  });
});

describe('pruneLookupCache', () => {
  it('removes only expired rows', async () => {
    const base = {
      facts: null,
      candidates: [],
      providers: [],
      miss: false,
      hits: 0,
      fetchedAt: new Date(),
    };
    store.set('expired', { ...base, upc: 'expired', expiresAt: new Date(Date.now() - 1000) });
    store.set('fresh', { ...base, upc: 'fresh', expiresAt: new Date(Date.now() + 60_000) });

    expect(await pruneLookupCache()).toBe(1);
    expect(store.has('fresh')).toBe(true);
    expect(store.has('expired')).toBe(false);
  });
});
