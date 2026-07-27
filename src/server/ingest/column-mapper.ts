import { CANONICAL_FIELDS, type CanonicalField, type ColumnMapping } from '@/lib/types';

/**
 * Supplier spreadsheets never agree on column names. "UPC", "upc_code",
 * "Barcode", "EAN", "GTIN-12" all mean the same thing. Rather than force the
 * user to map columns by hand, we score every header against a set of known
 * aliases and take the best match per field.
 */

interface FieldSpec {
  field: CanonicalField;
  /** Exact (normalised) header names, highest confidence. */
  aliases: string[];
  /** Substrings that suggest the field, lower confidence. */
  hints: string[];
  /** Substrings that disqualify a header outright. */
  blockers?: string[];
}

const SPECS: FieldSpec[] = [
  {
    field: 'upc',
    aliases: [
      'upc', 'upccode', 'upca', 'ean', 'ean13', 'gtin', 'gtin12', 'gtin13',
      'barcode', 'barcodenumber', 'itembarcode', 'productbarcode', 'isbn',
    ],
    hints: ['upc', 'ean', 'gtin', 'barcode'],
  },
  {
    field: 'sku',
    aliases: [
      'sku', 'skucode', 'itemnumber', 'itemno', 'itemid', 'itemcode',
      'productid', 'productno', 'productcode', 'partnumber', 'partno',
      'id', 'stockcode', 'articlenumber', 'vendorsku', 'suppliersku', 'mpn',
    ],
    hints: ['sku', 'itemnum', 'itemno', 'itemcode', 'productid', 'partnum'],
    blockers: ['image', 'photo', 'url'],
  },
  {
    field: 'name',
    aliases: [
      'name', 'productname', 'itemname', 'title', 'producttitle', 'itemtitle',
      'product', 'item', 'productdescription1', 'shortdescription', 'itemdesc',
    ],
    hints: ['productname', 'itemname', 'title', 'name'],
    blockers: ['brand', 'category', 'file', 'image'],
  },
  {
    field: 'brand',
    aliases: [
      'brand', 'brandname', 'manufacturer', 'mfg', 'mfr', 'make', 'vendor',
      'supplier', 'manufacturername',
    ],
    hints: ['brand', 'manufact', 'vendor', 'supplier'],
  },
  {
    field: 'model',
    aliases: [
      'model', 'modelnumber', 'modelno', 'modelname', 'mpn',
      'manufacturerpartnumber', 'manufacturernumber', 'styleno', 'stylenumber',
    ],
    hints: ['model', 'mpn', 'style'],
  },
  {
    field: 'description',
    aliases: [
      'description', 'productdescription', 'itemdescription', 'longdescription',
      'details', 'productdetails', 'fulldescription', 'desc', 'overview',
    ],
    hints: ['description', 'details', 'overview'],
    blockers: ['short'],
  },
  {
    field: 'specifications',
    aliases: [
      'specifications', 'specs', 'spec', 'features', 'attributes',
      'technicalspecs', 'productspecs', 'size', 'dimensions', 'color', 'colour',
    ],
    hints: ['spec', 'feature', 'attribute', 'dimension'],
  },
  {
    field: 'category',
    aliases: [
      'category', 'categories', 'department', 'producttype', 'type', 'class',
      'subcategory', 'productcategory', 'googlecategory',
    ],
    hints: ['category', 'department', 'producttype'],
  },
  {
    field: 'price',
    aliases: [
      'price', 'unitprice', 'retailprice', 'cost', 'msrp', 'listprice',
      'wholesaleprice', 'sellprice', 'yourprice', 'dealprice',
    ],
    hints: ['price', 'cost', 'msrp'],
  },
  {
    field: 'imageUrl',
    aliases: [
      'imageurl', 'image', 'imagelink', 'photo', 'photourl', 'picture',
      'pictureurl', 'mainimage', 'primaryimage', 'imgurl', 'img',
      'productimage', 'productimageurl', 'imagesrc',
    ],
    hints: ['imageurl', 'imagelink', 'photourl', 'pictureurl', 'imagesrc'],
  },
];

/** Lowercase, strip everything that is not a letter or digit. */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function scoreHeader(header: string, spec: FieldSpec): number {
  const key = normaliseHeader(header);
  if (!key) return 0;

  if (spec.blockers?.some((b) => key.includes(b))) return 0;

  const aliasIndex = spec.aliases.indexOf(key);
  if (aliasIndex === 0) return 1;
  // Later aliases are still exact matches, just less canonical.
  if (aliasIndex > 0) return 0.95 - Math.min(aliasIndex, 15) * 0.01;

  for (const hint of spec.hints) {
    if (key === hint) return 0.9;
    if (key.startsWith(hint) || key.endsWith(hint)) return 0.7;
    if (key.includes(hint)) return 0.6;
  }
  return 0;
}

/**
 * Assign headers to canonical fields. A header is used at most once; when two
 * fields want the same header the higher score wins, and the loser looks for
 * its next-best option.
 */
export function detectColumnMapping(headers: string[]): ColumnMapping {
  interface Pair { field: CanonicalField; header: string; score: number }

  const pairs: Pair[] = [];
  for (const spec of SPECS) {
    for (const header of headers) {
      const score = scoreHeader(header, spec);
      if (score > 0) pairs.push({ field: spec.field, header, score });
    }
  }

  // Greedy assignment over a score-sorted list. Ties broken by field order so
  // the result is deterministic regardless of header order in the file.
  const fieldOrder = new Map(CANONICAL_FIELDS.map((f, i) => [f, i]));
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      (fieldOrder.get(a.field) ?? 0) - (fieldOrder.get(b.field) ?? 0) ||
      headers.indexOf(a.header) - headers.indexOf(b.header),
  );

  const mapping: ColumnMapping = {};
  const takenHeaders = new Set<string>();
  for (const pair of pairs) {
    if (mapping[pair.field] !== undefined) continue;
    if (takenHeaders.has(pair.header)) continue;
    mapping[pair.field] = pair.header;
    takenHeaders.add(pair.header);
  }

  return mapping;
}

/**
 * A product needs *something* to identify it. Without a name or a barcode
 * there is nothing to search for and nothing to generate from.
 */
export function mappingIsUsable(mapping: ColumnMapping): boolean {
  return Boolean(mapping.name || mapping.upc);
}
