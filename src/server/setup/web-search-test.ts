import { env } from '@/lib/env';
import type { ProductEnrichment } from '@/lib/types';
import { openAiWebProvider, resetWebSearchTool } from '@/server/providers/search/openai-web';

/**
 * Run one real web image search and report exactly what came back.
 *
 * The web tier can be dead in several ways that all look identical from the
 * outside — every product comes back with one or two candidates from a barcode
 * database, some fail, and nothing anywhere says why. The tool name can be
 * rejected, the model can be one that has no hosted browsing tool, the reply
 * can run out of tokens before it writes its JSON, the account can lack access.
 * All of those used to end at "the web image search found nothing either",
 * which reads as "this product has no photographs" and is a completely
 * different problem with a completely different fix.
 *
 * So: search for a product that certainly has pictures, and say what happened.
 * A known-good barcode makes the result unambiguous — if this finds nothing,
 * the tier is broken, not the catalog.
 */

/** Coca-Cola 330ml. If the open web cannot find this, it cannot find anything. */
const KNOWN_GOOD = {
  upc: '5449000000996',
  title: 'Coca-Cola Classic Soft Drink 330ml Can',
  brand: 'Coca-Cola',
};

export type WebSearchState = 'ok' | 'off' | 'no_key' | 'empty' | 'failed';

export interface WebSearchTestResult {
  state: WebSearchState;
  /** What to do about it, in the language of the person who has to do it. */
  message: string;
  /** How many candidates the tier produced for a product that certainly has some. */
  candidates: number;
  /** Hosts the candidates came from, so a plausible-looking zero is visible. */
  hosts: string[];
  model: string;
  /** Raw provider error, when there was one. */
  detail?: string;
}

export async function testWebSearch(): Promise<WebSearchTestResult> {
  const config = env();
  const model = config.OPENAI_SEARCH_MODEL;

  if (!config.OPENAI_API_KEY) {
    return {
      state: 'no_key',
      message:
        'No OPENAI_API_KEY is set, so there is no web image search at all. Only the ' +
        'keyless barcode databases are running, which is why products they do not ' +
        'hold come back empty.',
      candidates: 0,
      hosts: [],
      model,
    };
  }

  if (config.OPENAI_WEB_SEARCH === 'off') {
    return {
      state: 'off',
      message:
        'OPENAI_WEB_SEARCH is set to "off", so the web image search is disabled and ' +
        'only the barcode databases are running. Remove that variable to switch it on.',
      candidates: 0,
      hosts: [],
      model,
    };
  }

  // Start from nothing remembered, so a tool name that failed earlier in this
  // process is rediscovered rather than reported as still broken.
  resetWebSearchTool();

  const enrichment: ProductEnrichment = {
    canonicalTitle: KNOWN_GOOD.title,
    brand: KNOWN_GOOD.brand,
    model: undefined,
    searchQueries: [KNOWN_GOOD.upc],
    generationPrompt: '',
    negativeKeywords: [],
    requiredKeywords: ['coca'],
    source: 'heuristic',
  };

  try {
    const result = await openAiWebProvider.search({
      upc: KNOWN_GOOD.upc,
      sku: null,
      name: KNOWN_GOOD.title,
      brand: KNOWN_GOOD.brand,
      model: null,
      enrichment,
      limit: 6,
    });

    const hosts = [
      ...new Set(
        result.candidates.map((candidate) => {
          try {
            return new URL(candidate.sourceUrl).hostname;
          } catch {
            return 'unparseable';
          }
        }),
      ),
    ];

    if (result.candidates.length === 0) {
      return {
        state: 'empty',
        message:
          `The search ran without error but found no images for a product that ` +
          `certainly has them. That usually means the model (${model}) is not ` +
          `actually browsing. Try a model that supports the hosted web-search tool, ` +
          `or set OPENAI_WEB_SEARCH=off to stop paying for a tier that returns nothing.`,
        candidates: 0,
        hosts,
        model,
      };
    }

    return {
      state: 'ok',
      message:
        `Working: ${result.candidates.length} image candidate(s) found for a known ` +
        `product, from ${hosts.join(', ')}.`,
      candidates: result.candidates.length,
      hosts,
      model,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      state: 'failed',
      message:
        `The web image search failed outright, so every product is running on the ` +
        `barcode databases alone. This is the reason rows come back with only one or ` +
        `two candidates.`,
      candidates: 0,
      hosts: [],
      model,
      detail,
    };
  }
}
