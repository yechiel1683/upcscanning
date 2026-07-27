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
  /** Allow Workflow B when no real image can be found. */
  allowAiGeneration: z.boolean().default(true),
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

export interface DownloadedImage {
  buffer: Buffer;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
}
