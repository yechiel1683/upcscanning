import { env } from '@/lib/env';
import type { ProductFacts, SearchCandidate, SearchResult } from '@/lib/types';
import { fetchJson, withRetry } from '@/server/lib/http';
import type { SearchContext, SearchProvider } from './types';

/**
 * Barcode databases.
 *
 * These are the highest-value sources: a GTIN is an exact key, so a hit is the
 * actual product rather than a visual guess. They return two things — pictures,
 * and facts about the product — and for a customer who uploaded nothing but a
 * column of barcodes, the facts matter as much as the pictures.
 */

function hasBarcode(context: SearchContext): boolean {
  return Boolean(context.upc && /^\d{8,14}$/.test(context.upc));
}

// ---------------------------------------------------------------------------
// UPCitemdb — broad general-merchandise coverage
// ---------------------------------------------------------------------------

interface UpcItemDbResponse {
  code?: string;
  items?: Array<{
    title?: string;
    brand?: string;
    model?: string;
    category?: string;
    description?: string;
    images?: string[];
  }>;
}

export const upcItemDbProvider: SearchProvider = {
  name: 'upcitemdb',
  tier: 'barcode',
  baseConfidence: 0.95,
  keyless: true,
  // The keyless trial allows roughly 100 lookups a day. Spacing calls out and
  // serialising them keeps a burst from consuming the whole allowance at once;
  // the lookup cache is what actually makes this tier viable in bulk.
  rateLimit: { minIntervalMs: 1500, maxConcurrent: 1 },

  isConfigured() {
    // The trial tier works without a key (rate limited to ~100 lookups/day),
    // so this provider is always available; a key just raises the ceiling.
    return true;
  },

  supports: hasBarcode,

  async search(context): Promise<SearchResult> {
    const config = env();
    const base = config.UPCITEMDB_API_KEY
      ? 'https://api.upcitemdb.com/prod/v1/lookup'
      : 'https://api.upcitemdb.com/prod/trial/lookup';

    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.UPCITEMDB_API_KEY) {
      headers.user_key = config.UPCITEMDB_API_KEY;
      headers.key_type = '3scale';
    }

    const data = await withRetry(() =>
      fetchJson<UpcItemDbResponse>(`${base}?upc=${encodeURIComponent(context.upc!)}`, { headers }),
    );

    const item = data.items?.[0];
    const candidates: SearchCandidate[] = [];

    for (const entry of data.items ?? []) {
      for (const image of entry.images ?? []) {
        if (!image) continue;
        candidates.push({
          provider: 'upcitemdb',
          sourceUrl: image,
          title: entry.title,
          providerConfidence: 0.95,
        });
        if (candidates.length >= context.limit) break;
      }
      if (candidates.length >= context.limit) break;
    }

    return {
      candidates,
      facts: item
        ? cleanFacts({
            title: item.title,
            brand: item.brand,
            model: item.model,
            category: item.category,
            description: item.description,
            source: 'upcitemdb',
          })
        : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Go-UPC — paid, very broad
// ---------------------------------------------------------------------------

interface GoUpcResponse {
  product?: {
    name?: string;
    description?: string;
    brand?: string;
    category?: string;
    imageUrl?: string;
    specs?: Array<[string, string]>;
  };
}

export const goUpcProvider: SearchProvider = {
  name: 'go-upc',
  tier: 'barcode',
  baseConfidence: 0.93,
  keyless: false,
  rateLimit: { minIntervalMs: 200, maxConcurrent: 4 },

  isConfigured() {
    return Boolean(env().GOUPC_API_KEY);
  },

  supports: hasBarcode,

  async search(context): Promise<SearchResult> {
    const config = env();
    const data = await withRetry(() =>
      fetchJson<GoUpcResponse>(
        `https://go-upc.com/api/v1/code/${encodeURIComponent(context.upc!)}`,
        { headers: { authorization: `Bearer ${config.GOUPC_API_KEY}` } },
      ),
    );

    const product = data.product;
    if (!product) return { candidates: [] };

    return {
      candidates: product.imageUrl
        ? [
            {
              provider: 'go-upc',
              sourceUrl: product.imageUrl,
              title: product.name,
              providerConfidence: 0.93,
            },
          ]
        : [],
      facts: cleanFacts({
        title: product.name,
        brand: product.brand,
        category: product.category,
        description: product.description,
        source: 'go-upc',
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// The Open Facts family — free, no key, good coverage of consumer goods
// ---------------------------------------------------------------------------

interface OpenFactsResponse {
  status?: number;
  product?: {
    product_name?: string;
    generic_name?: string;
    brands?: string;
    categories?: string;
    image_url?: string;
    image_front_url?: string;
    selected_images?: { front?: { display?: Record<string, string> } };
  };
}

/**
 * Open Food Facts and its sibling databases share one API shape. Together they
 * cover groceries, drinks, cosmetics, pet food, and a growing slice of general
 * merchandise — all keyless, which matters when someone is starting out with
 * nothing but an OpenAI key.
 */
function openFactsProvider(name: string, host: string, confidence: number): SearchProvider {
  return {
    name,
    tier: 'barcode',
    baseConfidence: confidence,
    keyless: true,
    // Open Facts is a donation-funded public service; be a good citizen.
    rateLimit: { minIntervalMs: 300, maxConcurrent: 2 },

    isConfigured() {
      return true;
    },

    supports: hasBarcode,

    async search(context): Promise<SearchResult> {
      const data = await withRetry(() =>
        fetchJson<OpenFactsResponse>(
          `https://${host}/api/v2/product/${encodeURIComponent(context.upc!)}.json`,
          { headers: { 'user-agent': 'CatalogForge/1.0 (product catalog tooling)' } },
        ),
      );

      if (data.status !== 1 || !data.product) return { candidates: [] };
      const product = data.product;

      const display = product.selected_images?.front?.display ?? {};
      const urls = [...Object.values(display), product.image_front_url, product.image_url].filter(
        (url): url is string => Boolean(url),
      );

      const seen = new Set<string>();
      const candidates: SearchCandidate[] = [];
      for (const url of urls) {
        if (seen.has(url)) continue;
        seen.add(url);
        candidates.push({
          provider: name,
          sourceUrl: url,
          title: [product.brands, product.product_name].filter(Boolean).join(' '),
          providerConfidence: confidence,
        });
        if (candidates.length >= context.limit) break;
      }

      return {
        candidates,
        facts: cleanFacts({
          title: product.product_name ?? product.generic_name,
          // These fields are comma-separated lists; the first entry is primary.
          brand: product.brands?.split(',')[0],
          category: product.categories?.split(',').pop(),
          description: product.generic_name,
          source: name,
        }),
      };
    },
  };
}

export const openFoodFactsProvider = openFactsProvider('openfoodfacts', 'world.openfoodfacts.org', 0.9);
export const openBeautyFactsProvider = openFactsProvider('openbeautyfacts', 'world.openbeautyfacts.org', 0.88);
export const openProductsFactsProvider = openFactsProvider('openproductsfacts', 'world.openproductsfacts.org', 0.86);
export const openPetFoodFactsProvider = openFactsProvider('openpetfoodfacts', 'world.openpetfoodfacts.org', 0.86);

// ---------------------------------------------------------------------------

/** Drop blank values and trim, so downstream merging never sees empty strings. */
function cleanFacts(facts: ProductFacts): ProductFacts | undefined {
  const clean = (value?: string) => {
    const trimmed = value?.replace(/\s+/g, ' ').trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  };

  const result: ProductFacts = {
    title: clean(facts.title),
    brand: clean(facts.brand),
    model: clean(facts.model),
    category: clean(facts.category),
    description: clean(facts.description),
    source: facts.source,
  };

  const hasAnything = Boolean(
    result.title || result.brand || result.model || result.category || result.description,
  );
  return hasAnything ? result : undefined;
}
