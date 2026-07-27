import { env } from '@/lib/env';
import type { ParsedProduct, ProductEnrichment } from '@/lib/types';
import { fetchJson } from '@/server/lib/http';

/**
 * Product understanding.
 *
 * Before searching for an image we need to know what the row actually
 * describes: which token is the brand, which is the model, what the product
 * *is*, and what a wrong match would look like. An LLM does this well; when no
 * key is configured we fall back to heuristics that are good enough to drive a
 * search, so the platform never hard-depends on a model provider.
 */

export interface EnrichmentInput {
  name: string;
  brand?: string | null;
  model?: string | null;
  upc?: string | null;
  sku?: string | null;
  description?: string | null;
  specifications?: string | null;
  category?: string | null;
}

export function toEnrichmentInput(product: ParsedProduct): EnrichmentInput {
  return {
    name: product.name,
    brand: product.brand,
    model: product.model,
    upc: product.upc,
    sku: product.sku,
    description: product.description,
    specifications: product.specifications,
    category: product.category,
  };
}

// ---------------------------------------------------------------------------
// Heuristic fallback
// ---------------------------------------------------------------------------

/**
 * Words that appear in listings for accessories, bundles, and replacement
 * parts. If a candidate image's title contains one of these but the product
 * doesn't, it is almost certainly the wrong item — a phone case instead of a
 * phone, a TV wall mount instead of a TV.
 */
const ACCESSORY_TERMS = [
  'case', 'cover', 'skin', 'sleeve', 'screen protector', 'mount', 'stand',
  'bracket', 'cable', 'charger', 'adapter', 'battery', 'replacement', 'refill',
  'manual', 'remote', 'strap', 'bag', 'holder', 'kit for', 'compatible with',
  'for use with', 'fits', 'accessory', 'accessories', 'spare part', 'bundle',
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'with', 'for', 'of', 'in', 'to', 'by', 'new',
  'inch', 'inches', 'pack', 'ct', 'count', 'pcs', 'piece', 'each', 'set',
]);

/** Model numbers look like "WF-1000XM5" or "DCD771C2": mixed letters and digits. */
function looksLikeModelNumber(token: string): boolean {
  if (token.length < 3 || token.length > 24) return false;
  if (!/\d/.test(token)) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  // Exclude measurements like "55in", "4K", "1080p", "16GB".
  if (/^\d+(\.\d+)?(in|ft|cm|mm|m|kg|lb|oz|g|k|p|hz|w|v|gb|tb|mb)$/i.test(token)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(token);
}

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s.-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

export function heuristicEnrichment(input: EnrichmentInput): ProductEnrichment {
  const name = input.name.trim();
  const tokens = name.split(/\s+/).filter(Boolean);

  const brand = input.brand?.trim() || (tokens.length > 1 ? tokens[0] : undefined);

  const model =
    input.model?.trim() ||
    tokens.find((t) => looksLikeModelNumber(t)) ||
    undefined;

  // Only keep the brand prefix once in the canonical title.
  let title = name;
  if (brand && !title.toLowerCase().includes(brand.toLowerCase())) {
    title = `${brand} ${title}`;
  }
  if (model && !title.toLowerCase().includes(model.toLowerCase())) {
    title = `${title} ${model}`;
  }
  const canonicalTitle = title.replace(/\s+/g, ' ').trim();

  // Queries run most-specific first so an exact barcode hit short-circuits the
  // fuzzier text searches.
  const queries: string[] = [];
  if (input.upc) queries.push(input.upc);
  if (brand && model) queries.push(`${brand} ${model}`);
  queries.push(canonicalTitle);
  if (brand && model) queries.push(`${brand} ${model} product photo white background`);
  queries.push(`${canonicalTitle} product image`);

  const required = [
    ...(brand ? significantWords(brand) : []),
    ...(model ? [model.toLowerCase()] : []),
  ];

  // An accessory term already in the product name is legitimate (the product
  // really is a case), so it must not also be a negative signal.
  const nameLower = canonicalTitle.toLowerCase();
  const negatives = ACCESSORY_TERMS.filter((term) => !nameLower.includes(term));

  return {
    canonicalTitle,
    brand,
    model,
    category: input.category?.trim() || undefined,
    searchQueries: dedupe(queries).slice(0, 5),
    generationPrompt: buildGenerationPrompt({ ...input, canonicalTitle, brand, model }),
    negativeKeywords: negatives,
    requiredKeywords: dedupe(required),
    source: 'heuristic',
  };
}

/**
 * The prompt is deliberately prescriptive about camera, lighting, and framing:
 * the output has to look like it came from the same studio as every other
 * image in the catalog, not like an art piece.
 */
export function buildGenerationPrompt(
  input: EnrichmentInput & { canonicalTitle?: string; brand?: string; model?: string },
): string {
  const subject = input.canonicalTitle ?? input.name;
  const details: string[] = [];
  if (input.brand) details.push(`Brand: ${input.brand}`);
  if (input.model) details.push(`Model: ${input.model}`);
  if (input.category) details.push(`Category: ${input.category}`);
  if (input.description) details.push(`Description: ${truncate(input.description, 400)}`);
  if (input.specifications) details.push(`Specifications: ${truncate(input.specifications, 250)}`);

  return [
    `Professional ecommerce product photograph of: ${subject}.`,
    details.join('. ') + (details.length ? '.' : ''),
    'Single product centered in frame on a pure white seamless background.',
    'Studio lighting with soft diffused key light, gentle fill, and a subtle natural contact shadow beneath the product.',
    'Shot on a 50mm lens at f/8, sharp focus edge to edge, true-to-life colors and materials.',
    'Catalog style suitable for Amazon or Shopify: no props, no people, no text overlays, no watermarks, no logos other than those physically on the product, no packaging unless the product is the packaging.',
    'Square composition with even margins around the product.',
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You identify retail products from messy supplier spreadsheet rows so that a downstream system can find a photograph of the exact item.

Respond with a single JSON object and nothing else. Schema:
{
  "canonicalTitle": string,       // clean, human-readable product title
  "brand": string | null,
  "model": string | null,         // manufacturer model/part number if identifiable
  "category": string | null,      // broad retail category
  "searchQueries": string[],      // 3-5 web image search queries, most specific first
  "generationPrompt": string,     // prompt for generating a studio product photo
  "negativeKeywords": string[],   // words in a search result title that would mean it is the WRONG product (e.g. accessories, cases, parts for this item)
  "requiredKeywords": string[]    // lowercase words that MUST appear in a correct match
}

Rules:
- Never invent a model number that is not implied by the input.
- negativeKeywords must not contain words that legitimately describe this product.
- generationPrompt must describe a single product on a pure white background, studio lit, catalog style, no text or people.`;

interface LlmResponse {
  canonicalTitle?: string;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  searchQueries?: string[];
  generationPrompt?: string;
  negativeKeywords?: string[];
  requiredKeywords?: string[];
}

/**
 * Which model service does the identification.
 *
 * Whichever key is present gets used; Anthropic wins when both are set, purely
 * because it is the more explicit choice. The point is that a single key of
 * either kind is enough — nobody should have to open a second account to get
 * past heuristics.
 */
export function understandingProvider(): { provider: 'anthropic' | 'openai' | 'heuristic'; model: string | null } {
  const config = env();
  if (config.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: config.ANTHROPIC_MODEL };
  if (config.OPENAI_API_KEY) return { provider: 'openai', model: config.OPENAI_TEXT_MODEL };
  return { provider: 'heuristic', model: null };
}

export async function enrichProduct(input: EnrichmentInput): Promise<ProductEnrichment> {
  const fallback = heuristicEnrichment(input);
  const { provider } = understandingProvider();
  if (provider === 'heuristic') return fallback;

  const userContent = describeInput(input);

  try {
    const text =
      provider === 'anthropic'
        ? await askAnthropic(userContent)
        : await askOpenAi(userContent);

    const parsed = parseJsonObject(text);
    if (!parsed) return fallback;

    return mergeEnrichment(parsed, fallback);
  } catch {
    // Enrichment is an optimisation, never a hard dependency: a model outage
    // degrades match quality but must not fail the batch.
    return fallback;
  }
}

function describeInput(input: EnrichmentInput): string {
  return [
    `Product name: ${input.name}`,
    input.brand ? `Brand column: ${input.brand}` : null,
    input.model ? `Model column: ${input.model}` : null,
    input.upc ? `UPC/barcode: ${input.upc}` : null,
    input.sku ? `SKU: ${input.sku}` : null,
    input.category ? `Category: ${input.category}` : null,
    input.description ? `Description: ${truncate(input.description, 800)}` : null,
    input.specifications ? `Specifications: ${truncate(input.specifications, 500)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function askAnthropic(userContent: string): Promise<string> {
  const config = env();
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const message = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });

  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

async function askOpenAi(userContent: string): Promise<string> {
  const config = env();

  const data = await fetchJson<OpenAiChatResponse>('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.OPENAI_TEXT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      // Guarantees parseable output instead of hoping the model behaves.
      response_format: { type: 'json_object' },
      max_tokens: 1024,
    }),
    timeoutMs: 45_000,
  });

  if (data.error?.message) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

function mergeEnrichment(parsed: LlmResponse, fallback: ProductEnrichment): ProductEnrichment {
  const queries = dedupe(
    (parsed.searchQueries ?? []).filter((q): q is string => typeof q === 'string' && q.length > 1),
  );

  return {
    canonicalTitle: nonEmpty(parsed.canonicalTitle) ?? fallback.canonicalTitle,
    brand: nonEmpty(parsed.brand) ?? fallback.brand,
    model: nonEmpty(parsed.model) ?? fallback.model,
    category: nonEmpty(parsed.category) ?? fallback.category,
    // Keep a barcode query first if we have one: it beats any text query.
    searchQueries: dedupe([
      ...fallback.searchQueries.filter((q) => /^\d{8,14}$/.test(q)),
      ...queries,
      ...fallback.searchQueries,
    ]).slice(0, 6),
    generationPrompt: nonEmpty(parsed.generationPrompt) ?? fallback.generationPrompt,
    negativeKeywords: dedupe(
      (parsed.negativeKeywords ?? fallback.negativeKeywords)
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.toLowerCase()),
    ),
    requiredKeywords: dedupe(
      (parsed.requiredKeywords ?? fallback.requiredKeywords)
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.toLowerCase()),
    ),
    source: 'llm',
  };
}

/** Models sometimes wrap JSON in prose or a code fence; recover the object. */
function parseJsonObject(text: string): LlmResponse | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1]?.trim() ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as LlmResponse;
  } catch {
    return null;
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value.trim());
  }
  return out;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
