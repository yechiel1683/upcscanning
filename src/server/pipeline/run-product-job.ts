import { BatchStatus, ImageSourceKind, LedgerReason, ProductStatus } from '@prisma/client';

import { DEFAULT_RENDER_OPTIONS, renderOptionsSchema, type ProductEnrichment } from '@/lib/types';
import { prisma } from '@/server/db';
import { buildFileName } from '@/server/images/naming';
import { keys, storage } from '@/server/storage';
import { processProduct } from './process-product';

/**
 * The database-facing wrapper around the pipeline: load a product, run it,
 * persist the image and the audit trail, keep the batch counters honest, and
 * bill (or refund) credits.
 */

export interface JobResult {
  productId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  message?: string;
}

export async function runProductJob(productId: string): Promise<JobResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { batch: { select: { id: true, userId: true, renderOptions: true, status: true } } },
  });

  if (!product) return { productId, status: 'skipped', message: 'Product no longer exists' };
  if (product.batch.status === BatchStatus.CANCELLED) {
    return { productId, status: 'skipped', message: 'Batch was cancelled' };
  }
  if (product.status === ProductStatus.SUCCEEDED) {
    return { productId, status: 'skipped', message: 'Already processed' };
  }

  const options = renderOptionsSchema
    .partial()
    .safeParse(product.batch.renderOptions ?? {})
    .data;
  const renderOptions = { ...DEFAULT_RENDER_OPTIONS, ...(options ?? {}) };

  await prisma.product.update({
    where: { id: productId },
    data: {
      status: ProductStatus.PROCESSING,
      attempts: { increment: 1 },
      errorMessage: null,
    },
  });

  // Mark the batch as running on the first product to reach this point.
  await prisma.batch.updateMany({
    where: { id: product.batchId, status: { in: [BatchStatus.QUEUED, BatchStatus.UPLOADED] } },
    data: { status: BatchStatus.PROCESSING, startedAt: new Date() },
  });

  try {
    const outcome = await processProduct({
      product: {
        id: product.id,
        rowNumber: product.rowNumber,
        name: product.name,
        sku: product.sku,
        upc: product.upc,
        brand: product.brand,
        model: product.model,
        description: product.description,
        category: product.category,
        imageUrl: readImageUrlFromExtra(product.extra),
      },
      options: renderOptions,
      cachedEnrichment: readEnrichment(product.enrichment),
    });

    // Replace any previous audit trail so a retry does not stack duplicates.
    await prisma.imageCandidate.deleteMany({ where: { productId } });
    if (outcome.candidates.length > 0) {
      await prisma.imageCandidate.createMany({
        data: outcome.candidates.slice(0, 25).map((entry) => ({
          productId,
          provider: entry.candidate.provider,
          sourceUrl: entry.candidate.sourceUrl.slice(0, 2000),
          pageUrl: entry.candidate.pageUrl?.slice(0, 2000),
          title: entry.candidate.title?.slice(0, 500),
          width: entry.candidate.width,
          height: entry.candidate.height,
          matchScore: entry.matchScore,
          qualityScore: entry.qualityScore,
          rejected: entry.rejected,
          rejectedReason: entry.rejectedReason?.slice(0, 500),
          selected: entry.selected,
        })),
      });
    }

    if (outcome.status === 'failed') {
      await failProduct(productId, product.batchId, outcome.reason, outcome.enrichment);
      return { productId, status: 'failed', message: outcome.reason };
    }

    const fileName = buildFileName({
      name: product.name,
      brand: product.brand,
      sku: product.sku,
      upc: product.upc,
      rowNumber: product.rowNumber,
      format: renderOptions.format,
    });

    const storageKey = keys.productImage(product.batchId, product.id, fileName);
    await storage().put(storageKey, outcome.render.buffer, outcome.render.mimeType);

    const kind =
      outcome.kind === 'AI_GENERATED'
        ? ImageSourceKind.AI_GENERATED
        : outcome.kind === 'USER_PROVIDED'
          ? ImageSourceKind.USER_PROVIDED
          : ImageSourceKind.REAL;

    await prisma.$transaction(async (tx) => {
      // A retry may leave an older asset behind; the newest render wins.
      await tx.imageAsset.deleteMany({ where: { productId } });
      await tx.imageAsset.create({
        data: {
          productId,
          kind,
          storageKey,
          fileName,
          mimeType: outcome.render.mimeType,
          width: outcome.render.width,
          height: outcome.render.height,
          bytes: outcome.render.bytes,
          background: renderOptions.background,
          provider: outcome.provider,
          sourceUrl: outcome.sourceUrl?.slice(0, 2000),
          qualityScore: outcome.qualityScore,
          matchScore: outcome.matchScore,
        },
      });

      await tx.product.update({
        where: { id: productId },
        data: {
          status: ProductStatus.SUCCEEDED,
          outputName: fileName,
          processedAt: new Date(),
          errorMessage: null,
          enrichment: outcome.enrichment as unknown as object,
        },
      });

      await tx.batch.update({
        where: { id: product.batchId },
        data: { processedCount: { increment: 1 }, successCount: { increment: 1 } },
      });

      await tx.creditLedger.create({
        data: {
          userId: product.batch.userId,
          delta: -1,
          reason:
            kind === ImageSourceKind.AI_GENERATED
              ? LedgerReason.IMAGE_GENERATED
              : LedgerReason.IMAGE_SOURCED,
          batchId: product.batchId,
          productId,
          note: outcome.provider,
        },
      });

      await tx.user.update({
        where: { id: product.batch.userId },
        data: { credits: { decrement: 1 } },
      });
    });

    await finaliseBatchIfDone(product.batchId);
    return { productId, status: 'succeeded' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failProduct(productId, product.batchId, message, null);
    return { productId, status: 'failed', message };
  }
}

async function failProduct(
  productId: string,
  batchId: string,
  message: string,
  enrichment: ProductEnrichment | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: productId },
      data: {
        status: ProductStatus.FAILED,
        errorMessage: message.slice(0, 1000),
        processedAt: new Date(),
        ...(enrichment ? { enrichment: enrichment as unknown as object } : {}),
      },
    });
    await tx.batch.update({
      where: { id: batchId },
      data: { processedCount: { increment: 1 }, failedCount: { increment: 1 } },
    });
  });

  await finaliseBatchIfDone(batchId);
}

/**
 * Close out a batch once nothing is left pending. Counters are advisory (a
 * crashed worker can leave them behind), so the authoritative check is a live
 * count of unfinished products.
 */
export async function finaliseBatchIfDone(batchId: string): Promise<void> {
  const remaining = await prisma.product.count({
    where: { batchId, status: { in: [ProductStatus.PENDING, ProductStatus.PROCESSING] } },
  });
  if (remaining > 0) return;

  const [succeeded, failed, skipped] = await Promise.all([
    prisma.product.count({ where: { batchId, status: ProductStatus.SUCCEEDED } }),
    prisma.product.count({ where: { batchId, status: ProductStatus.FAILED } }),
    prisma.product.count({ where: { batchId, status: ProductStatus.SKIPPED } }),
  ]);

  await prisma.batch.update({
    where: { id: batchId },
    data: {
      status: failed > 0 ? BatchStatus.COMPLETED_WITH_ERRORS : BatchStatus.COMPLETED,
      successCount: succeeded,
      failedCount: failed,
      skippedCount: skipped,
      processedCount: succeeded + failed + skipped,
      completedAt: new Date(),
    },
  });
}

function readEnrichment(value: unknown): ProductEnrichment | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ProductEnrichment>;
  if (typeof candidate.canonicalTitle !== 'string') return null;
  if (!Array.isArray(candidate.searchQueries)) return null;
  return candidate as ProductEnrichment;
}

/** The spreadsheet's image URL column is preserved in `extra` at ingest time. */
function readImageUrlFromExtra(extra: unknown): string | null {
  if (!extra || typeof extra !== 'object') return null;
  const value = (extra as Record<string, unknown>).__imageUrl;
  return typeof value === 'string' ? value : null;
}
