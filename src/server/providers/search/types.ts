import type { ProductEnrichment, SearchResult } from '@/lib/types';

export interface SearchContext {
  upc?: string | null;
  sku?: string | null;
  name: string;
  brand?: string | null;
  model?: string | null;
  enrichment: ProductEnrichment;
  /** Hard cap on candidates this provider should return. */
  limit: number;
}

/**
 * A barcode provider is keyed on an exact GTIN, so it can also tell us what the
 * product *is*. A web provider only knows where pictures live. The pipeline
 * runs the barcode tier first for exactly this reason: the facts it returns
 * make the web tier's queries far better.
 */
export type ProviderTier = 'barcode' | 'web';

export interface SearchProvider {
  readonly name: string;
  readonly tier: ProviderTier;
  /**
   * Baseline trust in this provider's results, before per-candidate scoring.
   * A barcode database that resolved the exact GTIN is near-certain; a generic
   * web image search is a guess that still has to be verified.
   */
  readonly baseConfidence: number;
  /** True when this provider needs no account of any kind. */
  readonly keyless: boolean;
  /** True when the provider has the credentials it needs. */
  isConfigured(): boolean;
  /** Providers keyed on a barcode are skipped for rows that have none. */
  supports(context: SearchContext): boolean;
  search(context: SearchContext): Promise<SearchResult>;
}
