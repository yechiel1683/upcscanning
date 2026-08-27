/**
 * Pulling real image URLs out of a product page.
 *
 * The web tier asked a browsing model for *direct image file URLs* — which is
 * the single thing a language model is worst at producing. A retailer's image
 * URL is a long opaque path with a hash in it; a model that has read the page
 * will confidently reconstruct something that looks exactly right and does not
 * exist. Those come back as HTML error pages ("not an image"), or as nothing at
 * all, and a product whose only other candidate is one barcode-database
 * thumbnail then fails outright.
 *
 * What the model *is* reliable about is which page the product is on. Every
 * retail page states its own images in its metadata, for exactly this purpose —
 * Open Graph tags are how a link renders a picture in a chat app. Reading them
 * turns the model's reliable output into image URLs that exist by construction,
 * because the page itself published them.
 *
 * It is also the best available answer to "the newest picture". A barcode
 * database's image is whatever was attached when the record was created, once,
 * years ago. A live retail listing shows what is in the warehouse this week.
 *
 * Parsing is deliberately regex-based rather than a DOM parse: this reads a few
 * specific meta tags out of documents that are frequently malformed, from a
 * server that must not spend a megabyte of parse tree on every candidate.
 */

/** Ordered best-first: how a page states its own primary image. */
const META_PATTERNS: Array<{ pattern: RegExp; source: string }> = [
  // <meta property="og:image" content="..."> in either attribute order.
  {
    pattern: /<meta[^>]+(?:property|name)=["']og:image(?::url|:secure_url)?["'][^>]*>/gi,
    source: 'og:image',
  },
  { pattern: /<meta[^>]+(?:property|name)=["']twitter:image(?::src)?["'][^>]*>/gi, source: 'twitter:image' },
  { pattern: /<link[^>]+rel=["']image_src["'][^>]*>/gi, source: 'image_src' },
];

/** Pull the value of content="" or href="" out of a single tag. */
function attributeValue(tag: string): string | null {
  const match =
    /\scontent=["']([^"']+)["']/i.exec(tag) ?? /\shref=["']([^"']+)["']/i.exec(tag);
  return match?.[1]?.trim() ?? null;
}

/**
 * Image URLs a JSON-LD Product block declares.
 *
 * schema.org allows `image` to be a string, an array of strings, or an
 * ImageObject with a `url`. Retailers use all three, and this is often the only
 * place a page states its full-resolution image rather than a rendered
 * thumbnail.
 */
function fromJsonLd(html: string): string[] {
  const urls: string[] = [];
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const block of blocks) {
    const body = block[1];
    if (!body) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Malformed JSON-LD is common enough not to be worth a word about.
      continue;
    }

    // The block may be a single node, a list, or a @graph wrapper.
    const queue: unknown[] = [parsed];
    let visited = 0;
    while (queue.length > 0 && visited < 200) {
      const node = queue.shift();
      visited += 1;
      if (Array.isArray(node)) {
        queue.push(...node);
        continue;
      }
      if (!node || typeof node !== 'object') continue;

      const record = node as Record<string, unknown>;
      if (Array.isArray(record['@graph'])) queue.push(...record['@graph']);

      const image = record.image;
      for (const entry of Array.isArray(image) ? image : [image]) {
        if (typeof entry === 'string') urls.push(entry);
        else if (entry && typeof entry === 'object') {
          const url = (entry as Record<string, unknown>).url;
          if (typeof url === 'string') urls.push(url);
        }
      }
    }
  }

  return urls;
}

/** Extensions that mean a URL is an image file rather than a page. */
const IMAGE_EXTENSION = /\.(?:jpe?g|png|webp|avif|tiff?)(?:$|[?#])/i;

/**
 * Things that are on every page and are never the product.
 *
 * A page's og:image is almost always the product, but its JSON-LD and its
 * `<img>` tags carry the site's furniture too. Passing a logo through costs a
 * download, an analysis, and a candidate slot that a real photograph needed.
 */
const NOT_A_PRODUCT = /\b(?:logo|sprite|icon|favicon|placeholder|avatar|banner|badge|pixel|tracking|spinner|loading)\b/i;

export interface PageImage {
  url: string;
  /** Which metadata stated it, best-first for ranking. */
  source: string;
}

/**
 * Image URLs a page states about itself, best first.
 *
 * Only metadata the page publishes deliberately — Open Graph, Twitter cards,
 * JSON-LD, `rel=image_src`. Scraping `<img>` tags is not included: on a retail
 * page most of them are navigation, recommendations and other products, and a
 * candidate that is confidently the *wrong* product is worse than no candidate.
 */
export function extractPageImages(html: string, pageUrl: string, limit = 6): PageImage[] {
  const found: PageImage[] = [];
  const seen = new Set<string>();

  const add = (raw: string, source: string) => {
    const absolute = absolutise(raw, pageUrl);
    if (!absolute) return;
    if (NOT_A_PRODUCT.test(absolute)) return;
    // Query-string renderers are legitimate, so an extension is evidence rather
    // than a requirement — but a URL with neither an extension nor a query is
    // far more likely to be a page than a picture.
    if (!IMAGE_EXTENSION.test(absolute) && !absolute.includes('?')) return;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    found.push({ url: absolute, source });
  };

  for (const { pattern, source } of META_PATTERNS) {
    for (const tag of html.matchAll(pattern)) {
      const value = attributeValue(tag[0]);
      if (value) add(value, source);
    }
  }

  for (const url of fromJsonLd(html)) add(url, 'json-ld');

  return found.slice(0, limit);
}

/** Resolve a possibly-relative URL against the page, rejecting anything odd. */
function absolutise(raw: string, pageUrl: string): string | null {
  const value = raw.trim().replace(/&amp;/g, '&');
  if (!value || value.startsWith('data:')) return null;

  try {
    const url = new URL(value, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Does this response body look like an HTML document rather than an image? */
export function looksLikeHtml(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml');
}
