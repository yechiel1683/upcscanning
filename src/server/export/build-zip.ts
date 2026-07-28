import { PassThrough } from 'node:stream';

import archiver from 'archiver';
import { stringify } from 'csv-stringify/sync';
import { ImageSourceKind } from '@prisma/client';

import type { ProductFacts } from '@/lib/types';
import { makeUniqueFileName } from '@/server/images/naming';

/**
 * The ZIP the customer actually downloads.
 *
 * Deliberately free of Prisma: accounts read their rows from the database and
 * guests hold theirs in memory, but both must receive an identical deliverable.
 * Duplicating this logic for the guest path would have guaranteed the two
 * drifted apart.
 */

export const ZIP_LAYOUT = {
  imagesDir: 'Product Images',
  csvName: 'products_with_images.csv',
  reportName: 'processing_report.txt',
  failuresName: 'failed_products.csv',
  readmeName: 'README.txt',
};

export interface ZipRow {
  rowNumber: number;
  sku: string | null;
  upc: string | null;
  name: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  description: string | null;
  price: number | null;
  facts: ProductFacts | null;
  succeeded: boolean;
  errorMessage: string | null;
  image: {
    id: string;
    kind: ImageSourceKind;
    fileName: string;
    width: number;
    height: number;
    provider: string | null;
    sourceUrl: string | null;
    matchScore: number;
    qualityScore: number;
    /** Resolved lazily so a large batch never holds every image at once. */
    read: () => Promise<Buffer>;
  } | null;
}

export interface ZipInput {
  batchName: string;
  createdAt: Date;
  rows: ZipRow[];
  /** Base URL for the hosted image links in the CSV; omitted for guests. */
  appUrl?: string;
  /** Extra note in the report, e.g. that this was a guest session. */
  notice?: string;
}

const CSV_COLUMNS = [
  'row', 'sku', 'upc', 'product_name', 'brand', 'model', 'category',
  'description', 'price', 'details_source',
  'image_file', 'image_url', 'image_type', 'image_source', 'source_url',
  'dimensions', 'match_confidence', 'quality_score', 'status',
];

const FAILURE_COLUMNS = [
  'row', 'sku', 'upc', 'product_name', 'brand', 'model', 'category',
  'description', 'price', 'details_source', 'reason',
];

export async function buildZip(input: ZipInput): Promise<{ buffer: Buffer; imageCount: number }> {
  const archive = archiver('zip', { zlib: { level: 6 } });
  const sink = new PassThrough();
  const chunks: Buffer[] = [];

  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    sink.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (warning) => console.warn('[export] archiver warning', warning));
  });

  archive.pipe(sink);

  const taken = new Set<string>();
  const csvRows: Array<Record<string, string>> = [];
  const failures: Array<Record<string, string>> = [];

  let imageCount = 0;
  let realCount = 0;
  let aiCount = 0;
  let providedCount = 0;

  for (const row of input.rows) {
    const base: Record<string, string> = {
      row: String(row.rowNumber),
      sku: row.sku ?? '',
      upc: row.upc ?? '',
      product_name: row.name,
      brand: row.brand ?? '',
      model: row.model ?? '',
      category: row.category ?? '',
      description: truncateCell(row.description),
      price: row.price === null ? '' : String(row.price),
      details_source: row.facts?.source ?? '',
    };

    if (row.succeeded && row.image) {
      const fileName = makeUniqueFileName(row.image.fileName, taken);
      try {
        archive.append(await row.image.read(), { name: `${ZIP_LAYOUT.imagesDir}/${fileName}` });
        imageCount += 1;

        if (row.image.kind === ImageSourceKind.AI_GENERATED) aiCount += 1;
        else if (row.image.kind === ImageSourceKind.USER_PROVIDED) providedCount += 1;
        else realCount += 1;

        csvRows.push({
          ...base,
          image_file: `${ZIP_LAYOUT.imagesDir}/${fileName}`,
          image_url: input.appUrl ? `${input.appUrl}/api/images/${row.image.id}/file` : '',
          image_type: describeKind(row.image.kind),
          image_source: row.image.provider ?? '',
          source_url: row.image.sourceUrl ?? '',
          dimensions: `${row.image.width}x${row.image.height}`,
          match_confidence: row.image.matchScore.toFixed(2),
          quality_score: row.image.qualityScore.toFixed(2),
          status: 'ok',
        });
        continue;
      } catch (error) {
        // The record says the image exists but the bytes are gone. Report it as
        // a failure rather than shipping a CSV that points at nothing.
        const message = error instanceof Error ? error.message : String(error);
        csvRows.push({ ...base, ...emptyImageColumns(), status: `missing: ${message}` });
        failures.push({ ...base, reason: `Image file missing: ${message}` });
        continue;
      }
    }

    csvRows.push({
      ...base,
      ...emptyImageColumns(),
      status: row.errorMessage ? 'failed' : 'not processed',
    });
    failures.push({ ...base, reason: row.errorMessage ?? 'Not processed' });
  }

  archive.append(stringify(csvRows, { header: true, columns: CSV_COLUMNS, bom: true }), {
    name: ZIP_LAYOUT.csvName,
  });

  if (failures.length > 0) {
    archive.append(stringify(failures, { header: true, columns: FAILURE_COLUMNS, bom: true }), {
      name: ZIP_LAYOUT.failuresName,
    });
  }

  archive.append(
    buildReport(input, { imageCount, realCount, aiCount, providedCount, failures: failures.length }),
    { name: ZIP_LAYOUT.reportName },
  );
  archive.append(buildReadme(aiCount), { name: ZIP_LAYOUT.readmeName });

  await archive.finalize();
  await finished;

  return { buffer: Buffer.concat(chunks), imageCount };
}

function emptyImageColumns(): Record<string, string> {
  return {
    image_file: '', image_url: '', image_type: '', image_source: '',
    source_url: '', dimensions: '', match_confidence: '', quality_score: '',
  };
}

function truncateCell(value: string | null): string {
  if (!value) return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  // Excel refuses to open cells beyond 32,767 characters.
  return collapsed.length > 2000 ? `${collapsed.slice(0, 1997)}...` : collapsed;
}

function describeKind(kind: ImageSourceKind): string {
  switch (kind) {
    case ImageSourceKind.AI_GENERATED:
      return 'AI generated';
    case ImageSourceKind.USER_PROVIDED:
      return 'Supplied in spreadsheet';
    default:
      return 'Real product photo';
  }
}

interface ReportStats {
  imageCount: number;
  realCount: number;
  aiCount: number;
  providedCount: number;
  failures: number;
}

function buildReport(input: ZipInput, stats: ReportStats): string {
  const total = input.rows.length;
  const pct = (n: number) => (total === 0 ? '0.0' : ((n / total) * 100).toFixed(1));

  return [
    'UPC Scanning — Processing Report',
    '='.repeat(64),
    '',
    `Batch:            ${input.batchName}`,
    `Uploaded:         ${input.createdAt.toISOString()}`,
    `Report generated: ${new Date().toISOString()}`,
    input.notice ? `\n${input.notice}` : '',
    '',
    'Summary',
    '-'.repeat(64),
    `Products in batch:        ${total}`,
    `Images produced:          ${stats.imageCount} (${pct(stats.imageCount)}%)`,
    `  Real product photos:    ${stats.realCount}`,
    `  Supplied in spreadsheet:${String(stats.providedCount).padStart(2)}`,
    `  AI generated:           ${stats.aiCount}`,
    `Products without images:  ${stats.failures}`,
    '',
    stats.aiCount > 0
      ? [
          'Note on AI-generated images',
          '-'.repeat(64),
          `${stats.aiCount} image(s) here were generated by an AI model because no real`,
          'photograph of the product could be found. They are marked "AI generated"',
          'in the image_type column of products_with_images.csv. Review them before',
          'publishing them as product photography.',
          '',
        ].join('\n')
      : '',
    stats.failures > 0
      ? [
          'Products without images',
          '-'.repeat(64),
          `${stats.failures} product(s) produced no image. See failed_products.csv for the`,
          'reason for each. Common causes: no barcode and an ambiguous product name,',
          'a supplier image URL that no longer resolves, or every candidate failing',
          'the quality threshold.',
          '',
        ].join('\n')
      : '',
  ]
    .filter((section) => section !== '')
    .join('\n');
}

function buildReadme(aiCount: number): string {
  return [
    'UPC Scanning export',
    '='.repeat(64),
    '',
    'Contents',
    '-'.repeat(64),
    `  ${ZIP_LAYOUT.imagesDir}/     One image per successfully processed product.`,
    `  ${ZIP_LAYOUT.csvName}        Your rows plus the details we discovered, the`,
    '                                matching image filename, provenance, and scores.',
    `  ${ZIP_LAYOUT.reportName}          Summary of what was processed.`,
    `  ${ZIP_LAYOUT.failuresName}          Products that produced no image, with reasons.`,
    '',
    'File naming',
    '-'.repeat(64),
    '  Brand_Product_Name_SKU.jpg — for example Samsung_55_Inch_Smart_TV_12345.jpg',
    '  The trailing identifier is the SKU, or the barcode, or the row number,',
    '  whichever was available. It keeps similar products distinct.',
    '',
    'Image provenance',
    '-'.repeat(64),
    '  Every row in the CSV carries an image_type:',
    '    Real product photo        Sourced and verified against your product data.',
    '    Supplied in spreadsheet   Downloaded from the image URL in your upload.',
    '    AI generated              Synthesised because no real photo was found.',
    aiCount > 0
      ? '\n  This export contains AI-generated images. Check them before publishing.'
      : '',
    '',
  ]
    .filter(Boolean)
    .join('\n');
}
