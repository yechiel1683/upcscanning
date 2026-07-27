import { PassThrough } from 'node:stream';

import archiver from 'archiver';
import { stringify } from 'csv-stringify/sync';
import { ExportStatus, ImageSourceKind, ProductStatus } from '@prisma/client';

import { env } from '@/lib/env';
import { prisma } from '@/server/db';
import { makeUniqueFileName } from '@/server/images/naming';
import { keys, storage } from '@/server/storage';

/**
 * Export builder.
 *
 * Produces the deliverable the customer actually wants: one ZIP holding every
 * image, plus the paperwork that makes it usable — a CSV of the original rows
 * with image filenames attached, a human-readable processing report, and an
 * explicit list of what failed so nothing silently goes missing.
 */

export interface ExportLayout {
  imagesDir: string;
  csvName: string;
  reportName: string;
  failuresName: string;
  readmeName: string;
}

const LAYOUT: ExportLayout = {
  imagesDir: 'Product Images',
  csvName: 'products_with_images.csv',
  reportName: 'processing_report.txt',
  failuresName: 'failed_products.csv',
  readmeName: 'README.txt',
};

export async function buildExport(exportId: string): Promise<void> {
  const record = await prisma.export.findUnique({
    where: { id: exportId },
    include: { batch: { select: { id: true, name: true, userId: true, createdAt: true } } },
  });
  if (!record) return;

  await prisma.export.update({
    where: { id: exportId },
    data: { status: ExportStatus.BUILDING, errorMessage: null },
  });

  try {
    const { buffer, imageCount } = await createZip(record.batchId);
    const storageKey = keys.export(record.batchId, exportId, record.fileName);
    await storage().put(storageKey, buffer, 'application/zip');

    await prisma.export.update({
      where: { id: exportId },
      data: {
        status: ExportStatus.READY,
        storageKey,
        bytes: buffer.byteLength,
        imageCount,
        // Exports are regenerable, so they do not need to live forever.
        expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      },
    });
  } catch (error) {
    await prisma.export.update({
      where: { id: exportId },
      data: {
        status: ExportStatus.FAILED,
        errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      },
    });
    throw error;
  }
}

export async function createZip(batchId: string): Promise<{ buffer: Buffer; imageCount: number }> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: {
      products: {
        orderBy: { rowNumber: 'asc' },
        include: { images: { where: { isPrimary: true }, take: 1 } },
      },
    },
  });
  if (!batch) throw new Error('Batch not found');

  const archive = archiver('zip', { zlib: { level: 6 } });
  const sink = new PassThrough();
  const chunks: Buffer[] = [];

  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    sink.on('end', resolve);
    sink.on('error', reject);
    archive.on('error', reject);
    // A missing source file should not abort the whole export.
    archive.on('warning', (warning) => console.warn('[export] archiver warning', warning));
  });

  archive.pipe(sink);

  const store = storage();
  const takenNames = new Set<string>();
  const csvRows: Array<Record<string, string>> = [];
  const failures: Array<Record<string, string>> = [];

  let imageCount = 0;
  let realCount = 0;
  let aiCount = 0;
  let providedCount = 0;

  for (const product of batch.products) {
    const image = product.images[0];
    const baseRow: Record<string, string> = {
      row: String(product.rowNumber),
      sku: product.sku ?? '',
      upc: product.upc ?? '',
      product_name: product.name,
      brand: product.brand ?? '',
      model: product.model ?? '',
      category: product.category ?? '',
      price: product.price ? product.price.toString() : '',
    };

    if (product.status === ProductStatus.SUCCEEDED && image) {
      const fileName = makeUniqueFileName(image.fileName, takenNames);
      try {
        const bytes = await store.get(image.storageKey);
        archive.append(bytes, { name: `${LAYOUT.imagesDir}/${fileName}` });
        imageCount += 1;

        if (image.kind === ImageSourceKind.AI_GENERATED) aiCount += 1;
        else if (image.kind === ImageSourceKind.USER_PROVIDED) providedCount += 1;
        else realCount += 1;

        csvRows.push({
          ...baseRow,
          image_file: `${LAYOUT.imagesDir}/${fileName}`,
          image_url: `${env().APP_URL}/api/images/${image.id}/file`,
          image_type: describeKind(image.kind),
          image_source: image.provider ?? '',
          source_url: image.sourceUrl ?? '',
          dimensions: `${image.width}x${image.height}`,
          match_confidence: image.matchScore.toFixed(2),
          quality_score: image.qualityScore.toFixed(2),
          status: 'ok',
        });
      } catch (error) {
        // The database says the image exists but storage disagrees. Report it
        // as a failure rather than shipping a CSV that points at nothing.
        const message = error instanceof Error ? error.message : String(error);
        csvRows.push({ ...baseRow, image_file: '', image_url: '', image_type: '', image_source: '', source_url: '', dimensions: '', match_confidence: '', quality_score: '', status: `missing: ${message}` });
        failures.push({ ...baseRow, reason: `Image file missing from storage: ${message}` });
      }
    } else {
      csvRows.push({
        ...baseRow,
        image_file: '',
        image_url: '',
        image_type: '',
        image_source: '',
        source_url: '',
        dimensions: '',
        match_confidence: '',
        quality_score: '',
        status: product.status === ProductStatus.FAILED ? 'failed' : 'not processed',
      });
      failures.push({
        ...baseRow,
        reason: product.errorMessage ?? `Product status: ${product.status}`,
      });
    }
  }

  const csvColumns = [
    'row', 'sku', 'upc', 'product_name', 'brand', 'model', 'category', 'price',
    'image_file', 'image_url', 'image_type', 'image_source', 'source_url',
    'dimensions', 'match_confidence', 'quality_score', 'status',
  ];

  archive.append(stringify(csvRows, { header: true, columns: csvColumns, bom: true }), {
    name: LAYOUT.csvName,
  });

  if (failures.length > 0) {
    archive.append(
      stringify(failures, {
        header: true,
        columns: ['row', 'sku', 'upc', 'product_name', 'brand', 'model', 'category', 'price', 'reason'],
        bom: true,
      }),
      { name: LAYOUT.failuresName },
    );
  }

  archive.append(
    buildReport(batch, { imageCount, realCount, aiCount, providedCount, failures: failures.length }),
    { name: LAYOUT.reportName },
  );

  archive.append(buildReadme(LAYOUT, aiCount), { name: LAYOUT.readmeName });

  await archive.finalize();
  await finished;

  return { buffer: Buffer.concat(chunks), imageCount };
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

function buildReport(
  batch: { name: string; createdAt: Date; products: unknown[] },
  stats: ReportStats,
): string {
  const total = batch.products.length;
  const pct = (n: number) => (total === 0 ? '0.0' : ((n / total) * 100).toFixed(1));

  return [
    'CatalogForge — Processing Report',
    '='.repeat(64),
    '',
    `Batch:            ${batch.name}`,
    `Uploaded:         ${batch.createdAt.toISOString()}`,
    `Report generated: ${new Date().toISOString()}`,
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
          `${stats.aiCount} image(s) in this export were generated by an AI model because no`,
          'real photograph of the product could be found. They are marked as',
          '"AI generated" in the image_type column of products_with_images.csv.',
          'Review them before publishing them as product photography.',
          '',
        ].join('\n')
      : '',
    stats.failures > 0
      ? [
          'Products without images',
          '-'.repeat(64),
          `${stats.failures} product(s) could not be completed. See failed_products.csv for the`,
          'reason for each one. Common causes: no barcode and an ambiguous product',
          'name, a supplier image URL that no longer resolves, or every candidate',
          'image failing the quality threshold.',
          '',
          'You can retry these from the batch page in the dashboard.',
          '',
        ].join('\n')
      : '',
  ]
    .filter((section) => section !== '')
    .join('\n');
}

function buildReadme(layout: ExportLayout, aiCount: number): string {
  return [
    'CatalogForge export',
    '='.repeat(64),
    '',
    'Contents',
    '-'.repeat(64),
    `  ${layout.imagesDir}/     One image per successfully processed product.`,
    `  ${layout.csvName}        Your product rows with the matching image filename,`,
    '                                a hosted URL, provenance, and confidence scores.',
    `  ${layout.reportName}          Summary of what was processed.`,
    `  ${layout.failuresName}          Products that produced no image, with reasons.`,
    '',
    'File naming',
    '-'.repeat(64),
    '  Brand_Product_Name_SKU.jpg — for example Samsung_55_Inch_Smart_TV_12345.jpg',
    '  The trailing identifier is the SKU, or the barcode, or the spreadsheet row',
    '  number, whichever was available. It keeps similar products distinct.',
    '',
    'Image provenance',
    '-'.repeat(64),
    '  Every row in the CSV carries an image_type:',
    '    Real product photo        Sourced from a barcode database or the web and',
    '                              verified against your product data.',
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
