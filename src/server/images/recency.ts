/**
 * How current a product photograph is likely to be.
 *
 * Packaging is redesigned. A body wash that has been on shelves for a decade
 * has had four or five looks, and every one of them is still on the internet —
 * so "a real photograph of the right product" is not the same as "the picture
 * of it that is true today". A catalog built from the oldest available image is
 * wrong in a way that passes every other check in this pipeline.
 *
 * Nothing here is certain, which is why it never overrides identity. It breaks
 * ties, and it breaks them towards now.
 *
 * Three signals, in descending order of how much they can be trusted:
 *
 *  1. A date the host states outright — a Last-Modified header, or a year in
 *     the path, which retail CDNs use constantly (/2024/03/, ?v=1712345678).
 *  2. Where the image lives. A manufacturer's own site and the large retailers
 *     carry what is on the shelf this week, because that is what they are
 *     selling. An aggregator carries whatever it scraped once.
 *  3. Nothing at all, which is neither good nor bad and scores in the middle,
 *     so an image is never punished for a host that simply says little.
 */

export interface RecencyInput {
  sourceUrl: string;
  pageUrl?: string;
  /** The Last-Modified header, when the host sent one. */
  lastModified?: string | null;
  /** Present so a test can pin "now" without touching the clock globally. */
  now?: Date;
}

/**
 * Hosts that sell the product, as opposed to hosts that catalogued it once.
 *
 * Deliberately a short list of the places whose imagery turns over with the
 * packaging. Adding somebody here says "this host's picture is probably
 * current", which is a claim worth making carefully.
 */
const CURRENT_STOCK_HOSTS = [
  'walmart.com',
  'target.com',
  'amazon.com',
  'media-amazon.com',
  'ssl-images-amazon.com',
  'cvs.com',
  'walgreens.com',
  'kroger.com',
  'costco.com',
  'samsclub.com',
  'wegmans.com',
  'instacart.com',
  'heb.com',
  'riteaid.com',
  'boots.com',
  'tesco.com',
  'sainsburys.co.uk',
];

/**
 * Aggregators and barcode databases.
 *
 * Not untrustworthy — a GTIN lookup is the most reliable way to know *what* a
 * product is — but their pictures are whatever was attached when the record was
 * created, and records are created once. This is precisely the tension: the
 * source that identifies a product best is the one most likely to show it as it
 * looked years ago.
 */
const ARCHIVE_HOSTS = [
  'upcitemdb.com',
  'go-upc.com',
  'barcodelookup.com',
  'openfoodfacts.org',
  'openbeautyfacts.org',
  'openproductsfacts.org',
  'openpetfoodfacts.org',
  'ean-search.org',
];

/** Years outside this range in a URL are version numbers or nonsense, not dates. */
const EARLIEST_PLAUSIBLE_YEAR = 2005;

export interface RecencyAssessment {
  /** 0 to 1. Higher means more likely to show current packaging. */
  score: number;
  /** Why, in a few words, for the audit trail. */
  reason: string;
}

export function scoreRecency(input: RecencyInput): RecencyAssessment {
  const now = input.now ?? new Date();
  const currentYear = now.getUTCFullYear();

  const stated = statedDate(input, now);
  if (stated !== null) {
    const age = currentYear - stated;
    if (age <= 1) return { score: 1, reason: `dated ${stated}` };
    if (age <= 3) return { score: 0.8, reason: `dated ${stated}` };
    if (age <= 6) return { score: 0.5, reason: `dated ${stated}` };
    return { score: 0.2, reason: `dated ${stated}` };
  }

  const host = hostOf(input.sourceUrl);
  const page = input.pageUrl ? hostOf(input.pageUrl) : '';

  if (matches(host, CURRENT_STOCK_HOSTS) || matches(page, CURRENT_STOCK_HOSTS)) {
    return { score: 0.75, reason: 'from a retailer selling it now' };
  }
  if (matches(host, ARCHIVE_HOSTS) || matches(page, ARCHIVE_HOSTS)) {
    return { score: 0.35, reason: 'from a barcode archive' };
  }

  return { score: 0.5, reason: 'no date signal' };
}

/** The most reliable date anyone told us about this image. */
function statedDate(input: RecencyInput, now: Date): number | null {
  const currentYear = now.getUTCFullYear();

  if (input.lastModified) {
    const parsed = new Date(input.lastModified);
    if (!Number.isNaN(parsed.getTime())) {
      const year = parsed.getUTCFullYear();
      // A host clock can be wrong, and some CDNs stamp "now" on every response.
      // Either way a year outside the plausible range says nothing.
      if (year >= EARLIEST_PLAUSIBLE_YEAR && year <= currentYear) return year;
    }
  }

  const fromUrl = yearInUrl(input.sourceUrl, currentYear) ?? (input.pageUrl ? yearInUrl(input.pageUrl, currentYear) : null);
  return fromUrl;
}

/**
 * A year embedded in a path or a cache-busting timestamp.
 *
 * Only a path segment that is exactly a year counts — a bare four digits
 * anywhere in a URL is far more often a product code, a size, or a pixel
 * dimension. The timestamp form is unambiguous enough to read directly.
 */
function yearInUrl(url: string, currentYear: number): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  for (const [, value] of parsed.searchParams) {
    // Seconds-since-epoch cache busters, as used by most retail CDNs.
    if (/^\d{10}$/.test(value)) {
      const year = new Date(Number(value) * 1000).getUTCFullYear();
      if (year >= EARLIEST_PLAUSIBLE_YEAR && year <= currentYear) return year;
    }
    if (/^\d{13}$/.test(value)) {
      const year = new Date(Number(value)).getUTCFullYear();
      if (year >= EARLIEST_PLAUSIBLE_YEAR && year <= currentYear) return year;
    }
  }

  for (const segment of parsed.pathname.split('/')) {
    if (!/^\d{4}$/.test(segment)) continue;
    const year = Number(segment);
    if (year >= EARLIEST_PLAUSIBLE_YEAR && year <= currentYear) return year;
  }

  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matches(host: string, list: string[]): boolean {
  if (!host) return false;
  return list.some((known) => host === known || host.endsWith(`.${known}`));
}
