import { env } from '@/lib/env';
import type { SearchCandidate } from '@/lib/types';
import { fetchJson, withRetry } from '@/server/lib/http';
import type { SearchContext, SearchProvider } from './types';

/**
 * Barcode databases. These are the highest-value sources in Workflow A: a GTIN
 * is an exact key, so a hit is the actual product rather than a visual guess.
 */

interface UpcItemDbResponse {
  code?: string;
  items?: Array<{
    title?: string;
    brand?: string;
    model?: string;
    images?: string[];
  }>;
}

export const upcItemDbProvider: SearchProvider = {
  name: 'upcitemdb',
  baseConfidence: 0.95,

  isConfigured() {
    // The trial tier works without a key (rate limited to ~100 requests/day),
    // so this provider is always available; a key just raises the ceiling.
    return true;
  },

  supports(context) {
    return Boolean(context.upc && /^\d{8,14}$/.test(context.upc));
  },

  async search(context) {
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

    const candidates: SearchCandidate[] = [];
    for (const item of data.items ?? []) {
      for (const image of item.images ?? []) {
        if (!image) continue;
        candidates.push({
          provider: 'upcitemdb',
          sourceUrl: image,
          title: item.title,
          providerConfidence: 0.95,
        });
        if (candidates.length >= context.limit) return candidates;
      }
    }
    return candidates;
  },
};

interface GoUpcResponse {
  product?: {
    name?: string;
    description?: string;
    brand?: string;
    imageUrl?: string;
  };
}

export const goUpcProvider: SearchProvider = {
  name: 'go-upc',
  baseConfidence: 0.93,

  isConfigured() {
    return Boolean(env().GOUPC_API_KEY);
  },

  supports(context) {
    return Boolean(context.upc && /^\d{8,14}$/.test(context.upc));
  },

  async search(context) {
    const config = env();
    const data = await withRetry(() =>
      fetchJson<GoUpcResponse>(
        `https://go-upc.com/api/v1/code/${encodeURIComponent(context.upc!)}`,
        { headers: { authorization: `Bearer ${config.GOUPC_API_KEY}` } },
      ),
    );

    const image = data.product?.imageUrl;
    if (!image) return [];
    return [
      {
        provider: 'go-upc',
        sourceUrl: image,
        title: data.product?.name,
        providerConfidence: 0.93,
      },
    ];
  },
};

/**
 * Open Food Facts covers grocery, beverage, and household barcodes. Free, no
 * key, and surprisingly good coverage for the FMCG lists that wholesalers send.
 */
interface OpenFoodFactsResponse {
  status?: number;
  product?: {
    product_name?: string;
    brands?: string;
    image_url?: string;
    image_front_url?: string;
    selected_images?: {
      front?: { display?: Record<string, string> };
    };
  };
}

export const openFoodFactsProvider: SearchProvider = {
  name: 'openfoodfacts',
  baseConfidence: 0.9,

  isConfigured() {
    return true;
  },

  supports(context) {
    return Boolean(context.upc && /^\d{8,14}$/.test(context.upc));
  },

  async search(context) {
    const data = await withRetry(() =>
      fetchJson<OpenFoodFactsResponse>(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(context.upc!)}.json`,
        { headers: { 'user-agent': 'CatalogForge/1.0 (product catalog tooling)' } },
      ),
    );

    if (data.status !== 1 || !data.product) return [];

    const display = data.product.selected_images?.front?.display ?? {};
    const urls = [
      ...Object.values(display),
      data.product.image_front_url,
      data.product.image_url,
    ].filter((u): u is string => Boolean(u));

    const seen = new Set<string>();
    const candidates: SearchCandidate[] = [];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      candidates.push({
        provider: 'openfoodfacts',
        sourceUrl: url,
        title: [data.product.brands, data.product.product_name].filter(Boolean).join(' '),
        providerConfidence: 0.9,
      });
      if (candidates.length >= context.limit) break;
    }
    return candidates;
  },
};
