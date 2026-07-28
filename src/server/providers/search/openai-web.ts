import { env } from '@/lib/env';
import type { ProductFacts, SearchCandidate, SearchResult } from '@/lib/types';
import { fetchJson, HttpError, withRetry } from '@/server/lib/http';
import type { SearchContext, SearchProvider } from './types';

/**
 * Image discovery through OpenAI's hosted web-search tool.
 *
 * Most people setting this up have exactly one API key. Without this provider
 * that key only powers *generating* pictures, which is the fallback path — so
 * every product without a barcode-database entry would be synthesised rather
 * than found. Here the same key drives the search tier as well, which is what
 * makes "give it any barcode and get the real product" work with one account.
 *
 * The model is asked to browse for the product and report direct image URLs.
 * Everything it returns is treated as an ordinary untrusted candidate: scored,
 * downloaded through the SSRF-guarded fetcher, and verified like any other.
 */

interface ResponsesOutputContent {
  type?: string;
  text?: string;
}

interface ResponsesOutputItem {
  type?: string;
  content?: ResponsesOutputContent[];
}

interface ResponsesApiResponse {
  output?: ResponsesOutputItem[];
  output_text?: string;
  error?: { message?: string };
}

interface ModelFinding {
  imageUrls?: unknown;
  pageUrl?: unknown;
  title?: unknown;
  brand?: unknown;
  model?: unknown;
  category?: unknown;
  description?: unknown;
  confidence?: unknown;
}

const INSTRUCTIONS = `You locate official product photography for retail products.

Search the web for the exact product described. Prefer the manufacturer's own
site, then a major retailer (Amazon, Walmart, Target, Best Buy, Home Depot).

Return ONLY a JSON object, no prose, no code fence:
{
  "imageUrls": string[],   // 1-6 DIRECT links to image files (.jpg/.jpeg/.png/.webp).
                           // Must be the image file itself, NOT a product page.
  "pageUrl": string|null,  // the product page the images came from
  "title": string|null,    // the product's real, full retail name
  "brand": string|null,
  "model": string|null,    // manufacturer model / part number
  "category": string|null,
  "description": string|null, // one or two factual sentences
  "confidence": number     // 0-1, how sure you are this is the exact product
}

Rules:
- Only include an image if you are confident it shows THIS product, not an
  accessory, a different model, or a similar-looking item.
- Never invent a URL. If you cannot find real images, return "imageUrls": [].
- Do not return thumbnails, sprites, logos, or placeholder images.`;

export const openAiWebProvider: SearchProvider = {
  name: 'openai-web',
  tier: 'web',
  // Higher than a raw image-search hit because the model is asked to verify
  // the product, but well below a barcode lookup: it is still a judgement.
  baseConfidence: 0.72,
  keyless: false,
  // Browsing calls are slow and metered; a modest ceiling keeps a large batch
  // from tripping account rate limits mid-run.
  rateLimit: { minIntervalMs: 250, maxConcurrent: 4 },

  isConfigured() {
    return Boolean(env().OPENAI_API_KEY) && env().OPENAI_WEB_SEARCH !== 'off';
  },

  supports() {
    return true;
  },

  async search(context): Promise<SearchResult> {
    const config = env();

    const query = [
      context.upc ? `Barcode (UPC/EAN): ${context.upc}` : null,
      `Product: ${context.enrichment.canonicalTitle}`,
      context.brand ? `Brand: ${context.brand}` : null,
      context.model ? `Model: ${context.model}` : null,
      context.sku ? `Supplier SKU: ${context.sku}` : null,
      '',
      context.upc
        ? 'Identify the exact product with this barcode, then find official product photography for it.'
        : 'Find official product photography for this exact product.',
    ]
      .filter((line) => line !== null)
      .join('\n');

    const data = await withRetry(() =>
      fetchJson<ResponsesApiResponse>('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.OPENAI_SEARCH_MODEL,
          instructions: INSTRUCTIONS,
          input: query,
          tools: [{ type: 'web_search' }],
          // Browsing plus a JSON answer takes a while; the outer HTTP timeout
          // is far too short for it.
          max_output_tokens: 1200,
        }),
        timeoutMs: 90_000,
      }),
    );

    if (data.error?.message) throw new HttpError(`OpenAI web search: ${data.error.message}`);

    const finding = parseFinding(extractText(data));
    if (!finding) return { candidates: [] };

    const confidence = clampConfidence(finding.confidence);
    const pageUrl = asHttpUrl(finding.pageUrl);
    const title = asText(finding.title);

    const candidates: SearchCandidate[] = [];
    const seen = new Set<string>();

    for (const raw of Array.isArray(finding.imageUrls) ? finding.imageUrls : []) {
      const url = asHttpUrl(raw);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      candidates.push({
        provider: 'openai-web',
        sourceUrl: url,
        pageUrl,
        title: title ?? context.enrichment.canonicalTitle,
        // The model's own confidence modulates the provider baseline, so a
        // hedged answer is ranked below a certain one.
        providerConfidence: 0.45 + confidence * 0.35,
      });

      if (candidates.length >= context.limit) break;
    }

    const facts: ProductFacts | undefined =
      title || finding.brand || finding.model
        ? {
            title: title,
            brand: asText(finding.brand),
            model: asText(finding.model),
            category: asText(finding.category),
            description: asText(finding.description),
            source: 'openai-web',
          }
        : undefined;

    // A low-confidence identification is worse than none: it would poison the
    // filename and the export CSV with a guess.
    return { candidates, facts: confidence >= 0.6 ? facts : undefined };
  },
};

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * The Responses API returns a list of output items; the assistant's text may
 * arrive alongside web-search call records. Accept either the convenience
 * field or the structured form.
 */
function extractText(data: ResponsesApiResponse): string {
  if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text;

  const parts: string[] = [];
  for (const item of data.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n');
}

function parseFinding(text: string): ModelFinding | null {
  if (!text.trim()) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1]?.trim() ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(body.slice(start, end + 1)) as ModelFinding;
  } catch {
    return null;
  }
}

function asText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'unknown') {
    return undefined;
  }
  return trimmed;
}

function asHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return undefined;
  try {
    // Reject anything that is not parseable before it reaches the fetcher.
    return new URL(trimmed).toString();
  } catch {
    return undefined;
  }
}

function clampConfidence(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0.5;
  return Math.max(0, Math.min(1, parsed));
}
