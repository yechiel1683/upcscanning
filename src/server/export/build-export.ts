import { ExportStatus, ProductStatus } from '@prisma/client';

import { env } from '@/lib/env';
import type { ProductFacts } from '@/lib/types';
import { prisma } from '@/server/db';
import { keys, storage } from '@/server/storage';
import { buildZip, type ZipRow } from './build-zip';

/**
 * Export builder for account batches. The ZIP itself is assembled by
 * ./build-zip, which guests share, so both paths produce byte-identical
 * paperwork.
 */

export async function buildExport(exportId: string): Promise<void> {
  const record = await prisma.export.findUnique({
    where: { id: exportId },
    include: { batch: { select: { id: true, name: true, createdAt: true } } },
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
        // Exports are regenerable, so they need not live forever.
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

  const store = storage();

  const rows: ZipRow[] = batch.products.map((product) => {
    const image = product.images[0];
    return {
      rowNumber: product.rowNumber,
      sku: product.sku,
      upc: product.upc,
      name: product.name,
      brand: product.brand,
      model: product.model,
      category: product.category,
      description: product.description,
      price: product.price ? Number(product.price) : null,
      facts: (product.facts as unknown as ProductFacts | null) ?? null,
      outcome:
        product.status === ProductStatus.SUCCEEDED
          ? 'ok'
          : product.status === ProductStatus.NEEDS_REVIEW
            ? 'needs_review'
            : 'failed',
      errorMessage: product.errorMessage,
      image: image
        ? {
            id: image.id,
            kind: image.kind,
            fileName: image.fileName,
            width: image.width,
            height: image.height,
            provider: image.provider,
            sourceUrl: image.sourceUrl,
            matchScore: image.matchScore,
            qualityScore: image.qualityScore,
            // Read lazily so a thousand-image batch never holds them all.
            read: () => store.get(image.storageKey),
          }
        : null,
    };
  });

  return buildZip({
    batchName: batch.name,
    createdAt: batch.createdAt,
    rows,
    appUrl: env().APP_URL,
  });
}
