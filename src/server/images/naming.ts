import type { OutputFormat } from '@/lib/types';

/**
 * Output file naming.
 *
 * The target shape is `Samsung_55_Inch_Smart_TV_12345.jpg`: brand and product
 * words in Title_Case, then the SKU (or barcode, or row number) as a stable
 * suffix so two similar products never collide. Names must survive Windows,
 * macOS, Linux, and being unzipped by someone's warehouse manager.
 */

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_STEM_LENGTH = 110;

const EXTENSIONS: Record<OutputFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

export function extensionFor(format: OutputFormat): string {
  return EXTENSIONS[format];
}

/** Convert an arbitrary string into underscore-joined, filesystem-safe words. */
export function slugifyWords(input: string): string {
  return (
    input
      .normalize('NFKD')
      // Drop combining marks so "Crème" becomes "Creme" rather than "Crme".
      .replace(/[̀-ͯ]/g, '')
      .replace(/["'’`]/g, '')
      // Keep inch marks and sizes readable: 55" -> 55, 1/2 -> 1_2.
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => {
        if (/^[A-Z0-9]+$/.test(word)) return word; // Preserve acronyms: TV, USB, 4K.
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join('_')
  );
}

export interface NameInput {
  name: string;
  brand?: string | null;
  sku?: string | null;
  upc?: string | null;
  rowNumber: number;
  format: OutputFormat;
}

/**
 * Build the file stem (no extension). Exported separately so the export
 * manifest and the stored asset can agree on naming without duplicating logic.
 */
export function buildFileStem(input: NameInput): string {
  const brand = input.brand ? slugifyWords(input.brand) : '';
  let title = slugifyWords(input.name);

  // Avoid "Samsung_Samsung_55_Inch_TV" when the name already carries the brand.
  if (brand && title.toLowerCase().startsWith(`${brand.toLowerCase()}_`)) {
    title = title.slice(brand.length + 1);
  } else if (brand && title.toLowerCase() === brand.toLowerCase()) {
    title = '';
  }

  const identifier =
    slugifyWords(String(input.sku ?? '')) ||
    slugifyWords(String(input.upc ?? '')) ||
    String(input.rowNumber).padStart(3, '0');

  let stem = [brand, title].filter(Boolean).join('_');
  if (!stem) stem = 'Product';

  // Trim the descriptive part, never the identifier — the identifier is what
  // makes the name unique.
  const budget = MAX_STEM_LENGTH - identifier.length - 1;
  if (stem.length > budget) {
    stem = stem.slice(0, budget).replace(/_+$/, '');
  }

  let result = `${stem}_${identifier}`;

  const firstSegment = result.split('_')[0]?.toUpperCase() ?? '';
  if (WINDOWS_RESERVED.has(firstSegment) || WINDOWS_RESERVED.has(result.toUpperCase())) {
    result = `Item_${result}`;
  }

  return result;
}

export function buildFileName(input: NameInput): string {
  return `${buildFileStem(input)}.${extensionFor(input.format)}`;
}

/**
 * Guarantee uniqueness across a batch. ZIP entries with identical names are a
 * silent data-loss bug in several unzip tools, so collisions get a counter.
 */
export function makeUniqueFileName(fileName: string, taken: Set<string>): string {
  const key = fileName.toLowerCase();
  if (!taken.has(key)) {
    taken.add(key);
    return fileName;
  }

  const dot = fileName.lastIndexOf('.');
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
  const ext = dot === -1 ? '' : fileName.slice(dot);

  for (let i = 2; i < 10_000; i += 1) {
    const candidate = `${stem}_${i}${ext}`;
    if (!taken.has(candidate.toLowerCase())) {
      taken.add(candidate.toLowerCase());
      return candidate;
    }
  }

  const fallback = `${stem}_${Date.now()}${ext}`;
  taken.add(fallback.toLowerCase());
  return fallback;
}
