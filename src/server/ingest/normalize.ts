/**
 * Value cleaning for spreadsheet cells. Supplier files are messy: numbers
 * arrive as text, barcodes lose their leading zeros to Excel, prices carry
 * currency symbols, and descriptions are full of stray whitespace.
 */

export function cleanText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  // Excel leaves these behind when a formula fails.
  if (/^#(N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NULL!|NUM!)$/i.test(text)) return undefined;
  if (/^(n\/?a|null|none|undefined|-|--)$/i.test(text)) return undefined;
  return text;
}

/** GS1 mod-10 check digit, used by UPC-A, EAN-8, EAN-13 and GTIN-14. */
export function isValidGtinChecksum(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  const check = Number(digits.at(-1));
  let sum = 0;
  // Weights alternate 3,1 from the right-most body digit.
  for (let i = body.length - 1, weight = 3; i >= 0; i -= 1, weight = weight === 3 ? 1 : 3) {
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === check;
}

export interface NormalisedUpc {
  value: string;
  valid: boolean;
  note?: string;
}

/**
 * Normalise a barcode. Excel loves to store "012345678901" as the number
 * 12345678901, so we re-pad short numeric strings to a known GTIN length when
 * doing so produces a valid check digit.
 */
export function normaliseUpc(raw: unknown): NormalisedUpc | undefined {
  const text = cleanText(raw);
  if (!text) return undefined;

  // Strip separators and any scientific-notation artefacts.
  let digits = text.replace(/[\s-]/g, '');
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(digits)) {
    const asNumber = Number(digits);
    if (Number.isFinite(asNumber)) digits = BigInt(Math.round(asNumber)).toString();
  }
  digits = digits.replace(/\D/g, '');
  if (!digits) return undefined;

  if (isValidGtinChecksum(digits)) return { value: digits, valid: true };

  // Try restoring leading zeros Excel dropped.
  for (const target of [8, 12, 13, 14]) {
    if (digits.length < target) {
      const padded = digits.padStart(target, '0');
      if (isValidGtinChecksum(padded)) {
        return { value: padded, valid: true, note: 'restored leading zeros' };
      }
    }
  }

  return {
    value: digits,
    valid: false,
    note: `barcode "${text}" failed its check digit; treated as a hint only`,
  };
}

/** Parse a price that may carry a currency symbol, thousands separators, or a comma decimal. */
export function normalisePrice(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
  const text = cleanText(raw);
  if (!text) return undefined;

  let body = text.replace(/[^\d.,-]/g, '');
  if (!body) return undefined;

  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');
  if (lastComma > lastDot) {
    // European style: 1.234,56
    body = body.replace(/\./g, '').replace(',', '.');
  } else {
    body = body.replace(/,/g, '');
  }

  const value = Number.parseFloat(body);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100) / 100;
}

export function normaliseUrl(raw: unknown): string | undefined {
  const text = cleanText(raw);
  if (!text) return undefined;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    // Reject hostnames that cannot be real (guards against a stray cell of prose).
    if (!url.hostname.includes('.')) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Build a display name when the spreadsheet has no name column, or the name
 * cell is empty. Falls back through brand/model/UPC so every row still has
 * something searchable.
 */
export function deriveName(parts: {
  name?: string;
  brand?: string;
  model?: string;
  description?: string;
  upc?: string;
  sku?: string;
}): string | undefined {
  if (parts.name) return parts.name;

  const composed = [parts.brand, parts.model].filter(Boolean).join(' ').trim();
  if (composed) return composed;

  if (parts.description) {
    // First clause of the description is usually the product itself.
    const clause = parts.description.split(/[.,;|]/)[0]?.trim();
    if (clause && clause.length >= 3) return clause.slice(0, 120);
  }

  if (parts.upc) return `Product ${parts.upc}`;
  if (parts.sku) return `Product ${parts.sku}`;
  return undefined;
}
