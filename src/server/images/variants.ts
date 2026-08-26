/**
 * Asking a CDN for the full-size version of a picture it just gave us small.
 *
 * A barcode database rarely hands back product photography. It hands back a
 * *thumbnail* of product photography, because that is what its own page needed,
 * and the size is baked into the URL it stores. Open Food Facts serves its
 * "display" variant at 400px on the long edge — which for a tall granola bar
 * wrapper is 185x400, small enough that this pipeline rejects it outright and
 * reports the product as having no usable image at all.
 *
 * The master is still there. Every one of these hosts encodes the requested
 * size in the URL, so the larger version is one string substitution away, and
 * the difference between failing a product and rendering it properly is knowing
 * the substitution.
 *
 * Everything here is a *guess at a better URL*, never a replacement. Callers try
 * the variants first and fall back to the original, so a host that has changed
 * its scheme costs one wasted request rather than a lost product.
 */

export interface VariantRule {
  /** Host suffix this rule applies to. */
  host: string;
  /** Returns a larger URL, or null when the pattern does not apply. */
  upgrade: (url: URL) => string | null;
}

/** What "as large as you have" means when a host wants a number. */
const LARGE = 2000;

const RULES: VariantRule[] = [
  {
    // Open Food Facts and its sibling databases. Sizes are a path segment:
    // front_en.4.400.jpg is the 400px render, .full.jpg is the original.
    host: 'openfoodfacts.org',
    upgrade: (url) => sizeSegmentToFull(url),
  },
  { host: 'openbeautyfacts.org', upgrade: (url) => sizeSegmentToFull(url) },
  { host: 'openproductsfacts.org', upgrade: (url) => sizeSegmentToFull(url) },
  { host: 'openpetfoodfacts.org', upgrade: (url) => sizeSegmentToFull(url) },
  {
    // Walmart states the render size in the query string.
    host: 'walmartimages.com',
    upgrade: (url) => setParams(url, { odnHeight: LARGE, odnWidth: LARGE }),
  },
  {
    // Amazon encodes transforms between the last two dots: ._SL160_.jpg,
    // ._AC_SX300_.jpg. Removing the block asks for the untransformed original.
    host: 'media-amazon.com',
    upgrade: (url) => stripAmazonModifier(url),
  },
  { host: 'ssl-images-amazon.com', upgrade: (url) => stripAmazonModifier(url) },
  {
    // Adobe Scene7, which Target and many others run on.
    host: 'scene7.com',
    upgrade: (url) => setParams(url, { wid: LARGE, hei: LARGE }),
  },
  {
    // Shopify appends _180x180 before the extension.
    host: 'cdn.shopify.com',
    upgrade: (url) => stripShopifySize(url),
  },
];

/**
 * Query parameters that mean "render it this big", on hosts with no rule of
 * their own. Applied only when the value present is small enough to be a
 * thumbnail request, so a URL that already asks for something large is left
 * alone rather than churned.
 */
const GENERIC_SIZE_PARAMS = ['w', 'width', 'h', 'height', 'size', 'sw', 'sh', 'maxwidth'];

/** Below this, a stated size is a thumbnail rather than a deliberate choice. */
const THUMBNAIL_CEILING = 800;

/**
 * Larger versions of the same picture, most promising first.
 *
 * Returns at most two, because each is a request that might 404 and the point
 * is to save a product, not to enumerate a CDN.
 */
export function largerVariants(sourceUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return [];
  }

  const host = url.hostname.toLowerCase();
  const variants: string[] = [];

  for (const rule of RULES) {
    if (host !== rule.host && !host.endsWith(`.${rule.host}`)) continue;
    const upgraded = rule.upgrade(new URL(url.toString()));
    if (upgraded && upgraded !== sourceUrl) variants.push(upgraded);
    break;
  }

  const generic = raiseGenericSizeParams(new URL(url.toString()));
  if (generic && generic !== sourceUrl && !variants.includes(generic)) variants.push(generic);

  return variants.slice(0, 2);
}

/**
 * A key that is the same for two URLs pointing at the same photograph.
 *
 * The same picture reaches this pipeline from several providers at several
 * sizes — a 400px render from one database and the master from another are one
 * image, not two. Offering both as "alternatives" would present somebody with
 * the same photograph twice and ask them to choose, which reads as a bug.
 *
 * Built from the same knowledge as the upgrade rules: strip whatever encodes a
 * size, keep what identifies the asset. Two different photographs from the same
 * host keep different paths and so keep different keys.
 */
export function canonicalImageKey(sourceUrl: string): string {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return sourceUrl.trim().toLowerCase();
  }

  url.pathname = url.pathname
    .replace(/\.(?:\d{2,4}|full)(\.(?:jpg|jpeg|png|webp))$/i, '$1')
    .replace(/\._[A-Za-z0-9_,]+_\.(jpg|jpeg|png|webp)$/i, '.$1')
    .replace(/_(\d{2,4})x(\d{2,4})?(\.(?:jpg|jpeg|png|webp))$/i, '$3');

  for (const key of [...GENERIC_SIZE_PARAMS, 'odnHeight', 'odnWidth', 'wid', 'hei']) {
    for (const name of [key, key.toUpperCase()]) url.searchParams.delete(name);
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const query = url.searchParams.toString();
  return `${host}${url.pathname.toLowerCase()}${query ? `?${query}` : ''}`;
}

/** `front_en.4.400.jpg` -> `front_en.4.full.jpg` */
function sizeSegmentToFull(url: URL): string | null {
  const replaced = url.pathname.replace(
    /\.(\d{2,4})(\.(?:jpg|jpeg|png|webp))$/i,
    (_match, _size: string, extension: string) => `.full${extension}`,
  );
  if (replaced === url.pathname) return null;
  url.pathname = replaced;
  return url.toString();
}

/** `x._SL160_.jpg` or `x._AC_SX300_.jpg` -> `x.jpg` */
function stripAmazonModifier(url: URL): string | null {
  const replaced = url.pathname.replace(/\._[A-Za-z0-9_,]+_\.(jpg|jpeg|png|webp)$/i, '.$1');
  if (replaced === url.pathname) return null;
  url.pathname = replaced;
  return url.toString();
}

/** `shirt_180x180.jpg` -> `shirt.jpg` */
function stripShopifySize(url: URL): string | null {
  const replaced = url.pathname.replace(/_(\d{2,4})x(\d{2,4})?(\.(?:jpg|jpeg|png|webp))$/i, '$3');
  if (replaced === url.pathname) return null;
  url.pathname = replaced;
  return url.toString();
}

function setParams(url: URL, values: Record<string, number>): string | null {
  let changed = false;
  for (const [key, value] of Object.entries(values)) {
    // Only rewrite what the host actually asked for; adding parameters a URL
    // did not have is guessing at an API rather than adjusting a request.
    if (!url.searchParams.has(key)) continue;
    if (Number(url.searchParams.get(key)) >= value) continue;
    url.searchParams.set(key, String(value));
    changed = true;
  }
  return changed ? url.toString() : null;
}

function raiseGenericSizeParams(url: URL): string | null {
  let changed = false;
  for (const key of GENERIC_SIZE_PARAMS) {
    for (const name of [key, key.toUpperCase()]) {
      if (!url.searchParams.has(name)) continue;
      const current = Number(url.searchParams.get(name));
      if (!Number.isFinite(current) || current <= 0 || current > THUMBNAIL_CEILING) continue;
      url.searchParams.set(name, String(LARGE));
      changed = true;
    }
  }
  return changed ? url.toString() : null;
}
