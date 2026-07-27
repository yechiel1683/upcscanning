import type { ParsedProduct, ParseResult, ParseWarning } from '@/lib/types';
import { cleanText, normaliseUpc } from './normalize';

/**
 * Parse a pasted list of barcodes.
 *
 * The most common way this job actually arrives is not a spreadsheet at all —
 * it is a column of numbers copied out of one, or typed off a packing slip.
 * Since the pipeline resolves a barcode to a real product on its own, that list
 * is all we need.
 *
 * Accepts one barcode per line, and tolerates a trailing label after a comma or
 * tab so a two-column copy-paste still works.
 */
export function parseBarcodeList(input: string, maxProducts?: number): ParseResult {
  const products: ParsedProduct[] = [];
  const skipped: ParseWarning[] = [];
  const warnings: ParseWarning[] = [];
  const seen = new Map<string, number>();

  const lines = input.split(/\r?\n/);

  lines.forEach((line, index) => {
    const rowNumber = index + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    if (maxProducts && products.length >= maxProducts) {
      skipped.push({
        rowNumber,
        message: `Line exceeds the ${maxProducts}-product limit for a single batch.`,
      });
      return;
    }

    // Split off an optional label: "036000291452, Duracell AA".
    const [codePart, ...rest] = trimmed.split(/[,\t;|]/);
    const label = cleanText(rest.join(' '));

    const rawDigits = (codePart ?? '').replace(/\D/g, '');
    if (!rawDigits) {
      skipped.push({ rowNumber, message: `"${truncate(trimmed)}" contains no digits.` });
      return;
    }

    // Zero-restoration is for a 11-digit UPC that a spreadsheet stripped, not
    // for a short typo — "123" would otherwise pad into a valid EAN-8.
    if (rawDigits.length < 8) {
      skipped.push({
        rowNumber,
        message: `"${truncate(trimmed)}" is too short to be a barcode (${rawDigits.length} digits).`,
      });
      return;
    }

    const upc = normaliseUpc(codePart);
    if (!upc) {
      skipped.push({ rowNumber, message: `"${truncate(trimmed)}" is not a readable barcode.` });
      return;
    }

    if (upc.note) warnings.push({ rowNumber, message: upc.note });

    const firstSeen = seen.get(upc.value);
    if (firstSeen !== undefined) {
      skipped.push({ rowNumber, message: `Duplicate of line ${firstSeen}.` });
      return;
    }
    seen.set(upc.value, rowNumber);

    products.push({
      rowNumber: products.length + 1,
      upc: upc.value,
      // A placeholder the pipeline replaces once the barcode resolves.
      name: label ?? `Product ${upc.value}`,
      extra: {},
    });
  });

  return {
    headers: ['UPC'],
    mapping: { upc: 'UPC' },
    products,
    skipped,
    warnings,
    totalRows: lines.filter((line) => line.trim()).length,
  };
}

function truncate(text: string): string {
  return text.length <= 40 ? text : `${text.slice(0, 37)}…`;
}
