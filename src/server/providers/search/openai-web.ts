import { env } from '@/lib/env';
import type { ProductFacts, SearchCandidate, SearchResult } from '@/lib/types';
import { extractPageImages } from '@/server/images/page-images';
import { fetchBinary, fetchJson, HttpError, withRetry } from '@/server/lib/http';
import type { SearchProvider } from './types';

/**
 * Image discovery through OpenAI's hosted web-search tool.
 *
 * Most people setting this up have exactly one API key. Without this provider
 * that key only powers *generating* pictures, which is the fallback path — so
 * every product without a barcode-database entry would be synthesised rather
 * than found. Here the same key drives the search tier as well, which is what
 * makes "give it any barcode and get the real product" work with one account.
 *
 * The model is asked for product *pages* first and image URLs only where it
 * actually saw them. That split is the whole design: a retailer's image URL is
 * a long opaque path with an id in it, so a model that has read the page will
 * reconstruct something that looks exactly right and does not exist — which
 * arrives here as an HTML error page, or as nothing. Which page the product is
 * on, it knows. So the pages are opened and asked what images they claim, and
 * the answer comes from the retailer's own metadata rather than from recall.
 *
 * Everything either route produces is treated as an ordinary untrusted
 * candidate: scored, downloaded through the SSRF-guarded fetcher, and verified
 * like any other.
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
  pageUrls?: unknown;
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
  "pageUrls": string[],    // 1-5 product PAGES for this exact product, best first.
                           // These matter most: list every retailer and the
                           // manufacturer's own page that you actually visited.
  "imageUrls": string[],   // 0-6 DIRECT links to image files (.jpg/.jpeg/.png/.webp),
                           // ONLY where you saw the exact URL. Leave empty if not.
  "pageUrl": string|null,  // the single best product page
  "title": string|null,    // the product's real, full retail name
  "brand": string|null,
  "model": string|null,    // manufacturer model / part number
  "category": string|null,
  "description": string|null, // one or two factual sentences
  "confidence": number     // 0-1, how sure you are this is the exact product
}

Rules:
- Only include a page or image if you are confident it is THIS product, not an
  accessory, a different size or flavour, or a similar-looking item.
- NEVER reconstruct or guess an image URL. A retailer's image URL contains an
  opaque id you cannot infer from the page. If you did not see the exact
  characters of the image URL, leave it out and give the page instead — the
  page is read afterwards and its images are taken from it directly.
- Prefer currently-selling listings over archived or discontinued ones: the
  goal is the packaging on shelves now.
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

    const data = await browse(query);

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

    // Now read the pages themselves.
    //
    // This is where most of the real candidates come from. The model names the
    // page reliably and reconstructs the image URL unreliably, so the pages it
    // listed are opened and asked what pictures they claim — which is metadata
    // the retailer publishes deliberately and which therefore exists.
    const pages: string[] = [];
    for (const raw of [
      ...(Array.isArray(finding.pageUrls) ? finding.pageUrls : []),
      finding.pageUrl,
    ]) {
      const url = asHttpUrl(raw);
      if (url && !pages.includes(url)) pages.push(url);
    }

    if (candidates.length < context.limit && pages.length > 0) {
      const fromPages = await imagesFromPages(pages.slice(0, MAX_PAGES_READ));
      for (const image of fromPages) {
        if (seen.has(image.url)) continue;
        seen.add(image.url);
        candidates.push({
          provider: 'openai-web',
          sourceUrl: image.url,
          pageUrl: image.pageUrl,
          title: title ?? context.enrichment.canonicalTitle,
          // Ranked above a URL the model typed out, because the page published
          // this one about itself rather than being remembered.
          providerConfidence: Math.min(0.9, 0.55 + confidence * 0.35),
        });
        if (candidates.length >= context.limit) break;
      }
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
// Reading the pages
// ---------------------------------------------------------------------------

/**
 * How many product pages are worth opening.
 *
 * Each is one small GET against a different host, and they run together, so the
 * product waits for the slowest rather than the sum. Three covers the
 * manufacturer plus a couple of retailers, which is where the disagreement that
 * makes a choice meaningful comes from.
 */
const MAX_PAGES_READ = 3;

/** A product page is HTML; anything of this size is not the part we want. */
const MAX_PAGE_BYTES = 1_500_000;

/**
 * Open each page and take the images it states about itself.
 *
 * Failures are silent by design. A retailer that blocks a server-side fetch, a
 * page that has moved, a timeout — none of these is a problem with the product,
 * and every one of them still leaves the other pages and the barcode tier.
 */
async function imagesFromPages(
  pages: string[],
): Promise<Array<{ url: string; pageUrl: string }>> {
  const results = await Promise.all(
    pages.map(async (pageUrl) => {
      try {
        const { buffer, contentType } = await fetchBinary(pageUrl, {
          maxBytes: MAX_PAGE_BYTES,
          headers: { accept: 'text/html,application/xhtml+xml' },
        });
        if (contentType && !contentType.startsWith('text/html')) return [];

        return extractPageImages(buffer.toString('utf8'), pageUrl).map((image) => ({
          url: image.url,
          pageUrl,
        }));
      } catch {
        return [];
      }
    }),
  );

  // Interleaved rather than concatenated: taking every image from the first
  // page before looking at the second would spend the whole candidate budget on
  // one retailer, and disagreement between retailers is the point.
  const merged: Array<{ url: string; pageUrl: string }> = [];
  const depth = Math.max(...results.map((list) => list.length), 0);
  for (let i = 0; i < depth; i += 1) {
    for (const list of results) {
      const entry = list[i];
      if (entry) merged.push(entry);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Calling the API
// ---------------------------------------------------------------------------

/**
 * The hosted browsing tool has gone by two names.
 *
 * It shipped as `web_search_preview` and was later also exposed as
 * `web_search`, and which one an account accepts depends on the API version it
 * is pinned to. Sending the wrong one is not a soft failure — it is a 400 that
 * takes the entire web tier down, silently, leaving a pipeline that looks like
 * it simply cannot find anything. Every product then falls through to whatever
 * comes next, which is exactly what a dead barcode link looks like from the
 * outside.
 *
 * So try both, and remember which worked. The discovery costs one extra request
 * once per process, and never having to think about it again is worth that.
 */
const TOOL_NAMES = ['web_search', 'web_search_preview'] as const;

let workingTool: string | null = null;

/** Test hook: forget which tool name this process settled on. */
export function resetWebSearchTool(): void {
  workingTool = null;
}

/** Does this error say the tool name was the problem, rather than the request? */
function looksLikeUnknownTool(error: unknown): boolean {
  if (!(error instanceof HttpError) || error.status !== 400) return false;
  return /web_search|tool/i.test(error.message);
}

async function browse(query: string): Promise<ResponsesApiResponse> {
  const config = env();
  const attempts = workingTool ? [workingTool] : TOOL_NAMES;
  let lastError: unknown;

  for (const tool of attempts) {
    try {
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
            tools: [{ type: tool }],
            // Browsing plus a JSON answer takes a while; the outer HTTP timeout
            // is far too short for it.
            max_output_tokens: 1200,
          }),
          timeoutMs: 90_000,
        }),
      );
      workingTool = tool;
      return data;
    } catch (error) {
      lastError = error;
      // Anything that is not "I do not know that tool" is a real failure and
      // must not be retried under a different name.
      if (!looksLikeUnknownTool(error)) throw error;
    }
  }

  throw lastError;
}

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
