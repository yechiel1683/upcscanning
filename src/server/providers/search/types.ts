import type { ProductEnrichment, SearchCandidate } from '@/lib/types';

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

export interface SearchProvider {
  readonly name: string;
  /**
   * Baseline trust in this provider's results, before per-candidate scoring.
   * A barcode database that resolved the exact GTIN is near-certain; a generic
   * web image search is a guess that still has to be verified.
   */
  readonly baseConfidence: number;
  /** True when the provider has the credentials it needs. */
  isConfigured(): boolean;
  /** Providers keyed on a barcode are skipped for rows that have none. */
  supports(context: SearchContext): boolean;
  search(context: SearchContext): Promise<SearchCandidate[]>;
}
