import { z } from 'zod';

/** The canonical fields a supplier spreadsheet can map onto. */
export const CANONICAL_FIELDS = [
  'sku',
  'upc',
  'name',
  'brand',
  'model',
  'description',
  'specifications',
  'category',
  'price',
  'imageUrl',
] as const;

export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** Header text -> canonical field. Headers absent from the map become `extra`. */
export type ColumnMapping = Partial<Record<CanonicalField, string>>;

export const columnMappingSchema = z.object(
  Object.fromEntries(CANONICAL_FIELDS.map((f) => [f, z.string().optional()])) as Record<
    CanonicalField,
    z.ZodOptional<z.ZodString>
  >,
);

/** A single normalised row, ready to be persisted as a Product. */
export interface ParsedProduct {
  rowNumber: number;
  sku?: string;
  upc?: string;
  name: string;
  brand?: string;
  model?: string;
  description?: string;
  specifications?: string;
  category?: string;
  price?: number;
  imageUrl?: string;
  extra: Record<string, string>;
}

export interface ParseWarning {
  rowNumber: number;
  message: string;
}

export interface ParseResult {
  headers: string[];
  mapping: ColumnMapping;
  products: ParsedProduct[];
  /** Rows dropped because they had no usable identity at all. */
  skipped: ParseWarning[];
  warnings: ParseWarning[];
  totalRows: number;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const BACKGROUNDS = ['white', 'transparent', 'light-gray', 'studio'] as const;
export type BackgroundStyle = (typeof BACKGROUNDS)[number];

export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export const renderOptionsSchema = z.object({
  width: z.number().int().min(256).max(4000).default(1600),
  height: z.number().int().min(256).max(4000).default(1600),
  background: z.enum(BACKGROUNDS).default('white'),
  format: z.enum(OUTPUT_FORMATS).default('jpeg'),
  quality: z.number().int().min(40).max(100).default(90),
  /** Fraction of the frame left empty around the product. Amazon uses ~0.15. */
  padding: z.number().min(0).max(0.4).default(0.08),
  removeBackground: z.boolean().default(true),
  /** Add a soft contact shadow beneath the product. */
  dropShadow: z.boolean().default(true),
  /**
   * Allow Workflow B when no real image can be found. Off by default.
   *
   * An image model does not know what a particular branded product looks like.
   * Asked for one it invents a plausible container — a blank-labelled bottle,
   * sometimes with the barcode number printed across it — which is not that
   * product and never will be. Three such images went into a catalog beside
   * three real photographs, indistinguishable at a glance apart from a small
   * badge, and there is no version of that which is worth having.
   *
   * Generation earns its place only where a representative picture is genuinely
   * better than an empty cell, and that is a decision for whoever is filling
   * the catalog — not a default. The default is the real photograph or an
   * honest gap.
   */
  allowAiGeneration: z.boolean().default(false),
  /** Stamp AI-generated images with a small corner badge. */
  watermarkAiImages: z.boolean().default(false),
});

export type RenderOptions = z.infer<typeof renderOptionsSchema>;

export const DEFAULT_RENDER_OPTIONS: RenderOptions = renderOptionsSchema.parse({});

// ---------------------------------------------------------------------------
// Provider contracts
// ---------------------------------------------------------------------------

/** What the LLM (or the heuristic fallback) works out about a product. */
export interface ProductEnrichment {
  /** Cleaned, human-readable product title. */
  canonicalTitle: string;
  brand?: string;
  model?: string;
  category?: string;
  /** Ordered search queries, most specific first. */
  searchQueries: string[];
  /** Prompt for Workflow B image generation. */
  generationPrompt: string;
  /** Words that, if present in a candidate's title, mean it's the wrong item. */
  negativeKeywords: string[];
  /** Words that should appear in a correct match. */
  requiredKeywords: string[];
  source: 'llm' | 'heuristic';
}

export interface SearchCandidate {
  provider: string;
  sourceUrl: string;
  pageUrl?: string;
  title?: string;
  width?: number;
  height?: number;
  /** Providers that resolve a UPC directly are inherently more trustworthy. */
  providerConfidence: number;
}

/**
 * What a lookup told us about the product itself, as opposed to where to find
 * a picture of it.
 *
 * This is what makes a bare list of barcodes useful: the customer uploads a
 * column of numbers and gets back names, brands, and models they never had.
 */
export interface ProductFacts {
  title?: string;
  brand?: string;
  model?: string;
  category?: string;
  description?: string;
  /** Which lookup produced these, for the export's provenance columns. */
  source: string;
}

export interface SearchResult {
  candidates: SearchCandidate[];
  facts?: ProductFacts;
}

/** Merge facts from several lookups; earlier sources win field by field. */
export function mergeFacts(entries: Array<ProductFacts | undefined>): ProductFacts | undefined {
  const present = entries.filter((entry): entry is ProductFacts => Boolean(entry));
  if (present.length === 0) return undefined;

  const merged: ProductFacts = { source: present.map((entry) => entry.source).join('+') };
  for (const entry of present) {
    merged.title ??= entry.title;
    merged.brand ??= entry.brand;
    merged.model ??= entry.model;
    merged.category ??= entry.category;
    merged.description ??= entry.description;
  }
  return merged;
}

export interface DownloadedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}
