import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';

import type {
  CanonicalField,
  ColumnMapping,
  ParsedProduct,
  ParseResult,
  ParseWarning,
} from '@/lib/types';
import { detectColumnMapping } from './column-mapper';
import {
  cleanText,
  deriveName,
  normalisePrice,
  normaliseUpc,
  normaliseUrl,
} from './normalize';

export type SheetRow = Record<string, unknown>;

export interface RawSheet {
  headers: string[];
  rows: SheetRow[];
}

export class IngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IngestError';
  }
}

// ---------------------------------------------------------------------------
// Raw readers
// ---------------------------------------------------------------------------

export function readCsv(buffer: Buffer): RawSheet {
  // `columns: true` would drop duplicate headers silently, so read positionally
  // and de-duplicate ourselves.
  const records = parseCsv(buffer, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  }) as string[][];

  if (records.length === 0) throw new IngestError('The file is empty.');

  const headerRowIndex = findHeaderRow(records);
  const rawHeaders = records[headerRowIndex] ?? [];
  const headers = dedupeHeaders(rawHeaders.map((h, i) => cleanText(h) ?? `Column ${i + 1}`));

  const rows: SheetRow[] = [];
  for (let i = headerRowIndex + 1; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    const row: SheetRow = {};
    headers.forEach((header, index) => {
      row[header] = record[index];
    });
    rows.push(row);
  }

  return { headers, rows };
}

export async function readXlsx(buffer: Buffer): Promise<RawSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const sheet = workbook.worksheets.find((w) => w.state !== 'hidden') ?? workbook.worksheets[0];
  if (!sheet) throw new IngestError('The workbook contains no worksheets.');

  const matrix: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: unknown[] = [];
    // ExcelJS row values are 1-indexed with a leading hole.
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      values[colNumber - 1] = extractCellValue(cell);
    });
    matrix.push(values);
  });

  if (matrix.length === 0) throw new IngestError('The worksheet is empty.');

  const headerRowIndex = findHeaderRow(matrix);
  const rawHeaders = matrix[headerRowIndex] ?? [];
  const headers = dedupeHeaders(
    rawHeaders.map((h, i) => cleanText(h) ?? `Column ${i + 1}`),
  );

  const rows: SheetRow[] = [];
  for (let i = headerRowIndex + 1; i < matrix.length; i += 1) {
    const record = matrix[i];
    if (!record) continue;
    const row: SheetRow = {};
    headers.forEach((header, index) => {
      row[header] = record[index];
    });
    rows.push(row);
  }

  return { headers, rows };
}

function extractCellValue(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value) return (value as ExcelJS.CellFormulaValue).result;
    if ('richText' in value) {
      return (value as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
    }
    if ('hyperlink' in value) return (value as ExcelJS.CellHyperlinkValue).hyperlink;
    if ('error' in value) return undefined;
  }
  return value;
}

/**
 * Suppliers often prefix their exports with a title row, a logo row, or a
 * blank line. Pick the first row that looks like a header: mostly non-empty,
 * mostly text, and not obviously a data row.
 */
function findHeaderRow(matrix: unknown[][]): number {
  const limit = Math.min(matrix.length, 15);
  let best = 0;
  let bestScore = -Infinity;

  for (let i = 0; i < limit; i += 1) {
    const row = matrix[i] ?? [];
    const cells = row.map((c) => cleanText(c)).filter(Boolean) as string[];
    if (cells.length < 2) continue;

    const textCells = cells.filter((c) => !/^-?[\d.,$%]+$/.test(c)).length;
    const shortCells = cells.filter((c) => c.length <= 40).length;
    const density = cells.length / Math.max(row.length, 1);

    // Headers are dense, textual, and short. Data rows have numbers and prose.
    const score = textCells * 2 + shortCells + density * 5 - i * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  return best;
}

function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = seen.get(header) ?? 0;
    seen.set(header, count + 1);
    return count === 0 ? header : `${header} (${count + 1})`;
  });
}

// ---------------------------------------------------------------------------
// Normalisation into products
// ---------------------------------------------------------------------------

export interface BuildOptions {
  /** Overrides detected mapping; provided by the user in the upload UI. */
  mappingOverride?: ColumnMapping;
  maxProducts?: number;
}

export function buildProducts(sheet: RawSheet, options: BuildOptions = {}): ParseResult {
  const detected = detectColumnMapping(sheet.headers);
  const mapping: ColumnMapping = { ...detected, ...stripEmpty(options.mappingOverride) };

  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean) as string[]);
  const extraHeaders = sheet.headers.filter((h) => !mappedHeaders.has(h));

  const products: ParsedProduct[] = [];
  const skipped: ParseWarning[] = [];
  const warnings: ParseWarning[] = [];
  const seenKeys = new Map<string, number>();

  const get = (row: SheetRow, field: CanonicalField): unknown => {
    const header = mapping[field];
    return header ? row[header] : undefined;
  };

  sheet.rows.forEach((row, index) => {
    // +2: one for the header row, one to make it 1-based like a spreadsheet.
    const rowNumber = index + 2;

    if (options.maxProducts && products.length >= options.maxProducts) {
      skipped.push({
        rowNumber,
        message: `Row exceeds the ${options.maxProducts}-product limit for a single batch.`,
      });
      return;
    }

    const upcResult = normaliseUpc(get(row, 'upc'));
    if (upcResult?.note) warnings.push({ rowNumber, message: upcResult.note });

    const sku = cleanText(get(row, 'sku'));
    const brand = cleanText(get(row, 'brand'));
    const model = cleanText(get(row, 'model'));
    const description = cleanText(get(row, 'description'));
    const specifications = cleanText(get(row, 'specifications'));
    const category = cleanText(get(row, 'category'));
    const price = normalisePrice(get(row, 'price'));
    const imageUrl = normaliseUrl(get(row, 'imageUrl'));

    const name = deriveName({
      name: cleanText(get(row, 'name')),
      brand,
      model,
      description,
      upc: upcResult?.value,
      sku,
    });

    if (!name) {
      // A completely blank row is not worth reporting; a partially filled one is.
      const hasAnyValue = Object.values(row).some((v) => cleanText(v) !== undefined);
      if (hasAnyValue) {
        skipped.push({
          rowNumber,
          message: 'No product name, brand/model, or barcode — nothing to identify this row by.',
        });
      }
      return;
    }

    const extra: Record<string, string> = {};
    for (const header of extraHeaders) {
      const value = cleanText(row[header]);
      if (value !== undefined) extra[header] = value;
    }

    // Dedupe on the strongest identity available.
    const dedupeKey = (upcResult?.valid && upcResult.value) || sku || `${name}::${brand ?? ''}`;
    const firstSeen = seenKeys.get(dedupeKey.toLowerCase());
    if (firstSeen !== undefined) {
      skipped.push({
        rowNumber,
        message: `Duplicate of row ${firstSeen} (same ${
          upcResult?.valid ? 'barcode' : sku ? 'SKU' : 'name and brand'
        }).`,
      });
      return;
    }
    seenKeys.set(dedupeKey.toLowerCase(), rowNumber);

    products.push({
      rowNumber,
      sku,
      upc: upcResult?.value,
      name,
      brand,
      model,
      description,
      specifications,
      category,
      price,
      imageUrl,
      extra,
    });
  });

  return {
    headers: sheet.headers,
    mapping,
    products,
    skipped,
    warnings,
    totalRows: sheet.rows.length,
  };
}

function stripEmpty(mapping?: ColumnMapping): ColumnMapping {
  if (!mapping) return {};
  const out: ColumnMapping = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (value) out[key as CanonicalField] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function parseSpreadsheet(
  buffer: Buffer,
  fileName: string,
  options: BuildOptions = {},
): Promise<ParseResult> {
  const extension = fileName.toLowerCase().split('.').pop() ?? '';

  let sheet: RawSheet;
  if (extension === 'csv' || extension === 'txt' || extension === 'tsv') {
    sheet = readCsv(buffer);
  } else if (extension === 'xlsx' || extension === 'xlsm' || extension === 'xls') {
    if (extension === 'xls' && !looksLikeZip(buffer)) {
      throw new IngestError(
        'Legacy .xls files are not supported. Re-save the file as .xlsx or .csv and upload it again.',
      );
    }
    sheet = await readXlsx(buffer);
  } else {
    throw new IngestError(
      `Unsupported file type ".${extension}". Upload a .csv, .xlsx, or .xlsm file.`,
    );
  }

  if (sheet.headers.length === 0) throw new IngestError('No column headers were found.');

  return buildProducts(sheet, options);
}

/** XLSX is a ZIP container; the ancient BIFF .xls format is not. */
function looksLikeZip(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}
