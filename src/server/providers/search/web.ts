import { env } from '@/lib/env';
import type { SearchCandidate, SearchResult } from '@/lib/types';
import { fetchJson, withRetry } from '@/server/lib/http';
import type { SearchContext, SearchProvider } from './types';

/**
 * General web image search. Lower trust than a barcode lookup — every result
 * has to be verified against the product before it can be used — but it is the
 * only source that covers the long tail of SKUs.
 */

interface GoogleCseResponse {
  items?: Array<{
    link?: string;
    title?: string;
    image?: { width?: number; height?: number; contextLink?: string };
  }>;
}

export const googleCseProvider: SearchProvider = {
  name: 'google-cse',
  tier: 'web',
  baseConfidence: 0.62,
  keyless: false,

  isConfigured() {
    const config = env();
    return Boolean(config.GOOGLE_CSE_API_KEY && config.GOOGLE_CSE_ENGINE_ID);
  },

  supports() {
    return true;
  },

  async search(context): Promise<SearchResult> {
    const config = env();
    const candidates: SearchCandidate[] = [];

    // Try queries in order and stop as soon as we have enough; each call costs
    // money, so a good first query saves the rest.
    for (const query of context.enrichment.searchQueries.slice(0, 3)) {
      if (candidates.length >= context.limit) break;

      const params = new URLSearchParams({
        key: config.GOOGLE_CSE_API_KEY!,
        cx: config.GOOGLE_CSE_ENGINE_ID!,
        q: query,
        searchType: 'image',
        num: String(Math.min(10, context.limit)),
        imgSize: 'large',
        safe: 'active',
      });

      const data = await withRetry(() =>
        fetchJson<GoogleCseResponse>(
          `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
        ),
      ).catch(() => null);

      for (const item of data?.items ?? []) {
        if (!item.link) continue;
        candidates.push({
          provider: 'google-cse',
          sourceUrl: item.link,
          pageUrl: item.image?.contextLink,
          title: item.title,
          width: item.image?.width,
          height: item.image?.height,
          providerConfidence: 0.62,
        });
      }
    }

    return { candidates: candidates.slice(0, context.limit) };
  },
};

interface BingResponse {
  value?: Array<{
    contentUrl?: string;
    hostPageUrl?: string;
    name?: string;
    width?: number;
    height?: number;
  }>;
}

export const bingImageProvider: SearchProvider = {
  name: 'bing-images',
  tier: 'web',
  baseConfidence: 0.6,
  keyless: false,

  isConfigured() {
    return Boolean(env().BING_SEARCH_API_KEY);
  },

  supports() {
    return true;
  },

  async search(context): Promise<SearchResult> {
    const config = env();
    const candidates: SearchCandidate[] = [];

    for (const query of context.enrichment.searchQueries.slice(0, 2)) {
      if (candidates.length >= context.limit) break;

      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(20, context.limit)),
        imageType: 'Photo',
        safeSearch: 'Strict',
      });

      const data = await withRetry(() =>
        fetchJson<BingResponse>(
          `https://api.bing.microsoft.com/v7.0/images/search?${params.toString()}`,
          { headers: { 'Ocp-Apim-Subscription-Key': config.BING_SEARCH_API_KEY! } },
        ),
      ).catch(() => null);

      for (const item of data?.value ?? []) {
        if (!item.contentUrl) continue;
        candidates.push({
          provider: 'bing-images',
          sourceUrl: item.contentUrl,
          pageUrl: item.hostPageUrl,
          title: item.name,
          width: item.width,
          height: item.height,
          providerConfidence: 0.6,
        });
      }
    }

    return { candidates: candidates.slice(0, context.limit) };
  },
};

interface SerpApiResponse {
  images_results?: Array<{
    original?: string;
    thumbnail?: string;
    link?: string;
    title?: string;
    original_width?: number;
    original_height?: number;
    source?: string;
  }>;
}

export const serpApiProvider: SearchProvider = {
  name: 'serpapi',
  tier: 'web',
  baseConfidence: 0.65,
  keyless: false,

  isConfigured() {
    return Boolean(env().SERPAPI_KEY);
  },

  supports() {
    return true;
  },

  async search(context): Promise<SearchResult> {
    const config = env();
    const candidates: SearchCandidate[] = [];

    for (const query of context.enrichment.searchQueries.slice(0, 2)) {
      if (candidates.length >= context.limit) break;

      const params = new URLSearchParams({
        engine: 'google_images',
        q: query,
        api_key: config.SERPAPI_KEY!,
        safe: 'active',
      });

      const data = await withRetry(() =>
        fetchJson<SerpApiResponse>(`https://serpapi.com/search.json?${params.toString()}`),
      ).catch(() => null);

      for (const item of data?.images_results ?? []) {
        const url = item.original ?? item.thumbnail;
        if (!url) continue;
        candidates.push({
          provider: 'serpapi',
          sourceUrl: url,
          pageUrl: item.link,
          title: item.title,
          width: item.original_width,
          height: item.original_height,
          // Results from a manufacturer or major retailer are worth more than
          // a random blog scrape.
          providerConfidence: isTrustedRetailer(item.source ?? item.link ?? '') ? 0.78 : 0.65,
        });
      }
    }

    return { candidates: candidates.slice(0, context.limit) };
  },
};

const TRUSTED_HOSTS = [
  'amazon.', 'walmart.', 'target.', 'bestbuy.', 'homedepot.', 'lowes.',
  'costco.', 'samsclub.', 'newegg.', 'bhphotovideo.', 'adorama.', 'wayfair.',
  'ebay.', 'shopify', 'apple.com', 'samsung.com', 'dewalt.com', 'lg.com',
  'sony.com', 'dell.com', 'hp.com', 'lenovo.com', 'bosch', 'makita',
  'staples.', 'officedepot.', 'sears.', 'kohls.', 'macys.',
];

export function isTrustedRetailer(source: string): boolean {
  const lower = source.toLowerCase();
  return TRUSTED_HOSTS.some((host) => lower.includes(host));
}

/**
 * The spreadsheet's own image_url column. Cheapest and most trustworthy source
 * there is — the supplier already told us where the photo lives.
 */
export function directUrlProvider(imageUrl: string): SearchProvider {
  return {
    name: 'spreadsheet',
    tier: 'web',
    baseConfidence: 0.99,
    keyless: true,
    isConfigured: () => true,
    supports: () => true,
    async search(context: SearchContext): Promise<SearchResult> {
      return {
        candidates: [
          {
            provider: 'spreadsheet',
            sourceUrl: imageUrl,
            title: context.name,
            providerConfidence: 0.99,
          },
        ],
      };
    },
  };
}
