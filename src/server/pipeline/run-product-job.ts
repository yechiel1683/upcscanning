import { BatchStatus, ImageSourceKind, LedgerReason, ProductStatus } from '@prisma/client';

import {
  DEFAULT_RENDER_OPTIONS,
  renderOptionsSchema,
  type ProductEnrichment,
  type ProductFacts,
} from '@/lib/types';
import { prisma } from '@/server/db';
import { buildFileName } from '@/server/images/naming';
import { keys, storage } from '@/server/storage';
import { queue } from '@/server/queue';
import { EFFORT_LADDER, effortForAttempt, processProduct } from './process-product';

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
  // A row awaiting a decision already has an image. Reprocessing it would throw
  // away the picture the customer is being asked about, so a duplicate job is a
  // no-op; an explicit retry clears the status first.
  if (
    product.status === ProductStatus.SUCCEEDED ||
    product.status === ProductStatus.NEEDS_REVIEW
  ) {
    return { productId, status: 'skipped', message: 'Already processed' };
  }

  const options = renderOptionsSchema
    .partial()
    .safeParse(product.batch.renderOptions ?? {})
    .data;
  const renderOptions = { ...DEFAULT_RENDER_OPTIONS, ...(options ?? {}) };

  const running = await prisma.product.update({
    where: { id: productId },
    data: {
      status: ProductStatus.PROCESSING,
      attempts: { increment: 1 },
      errorMessage: null,
      reviewReason: null,
    },
    select: { attempts: true },
  });
  const effort = effortForAttempt(running.attempts);

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
      effort,
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
      await failProduct(
        productId,
        product.batchId,
        outcome.reason,
        outcome.enrichment,
        outcome.facts,
        running.attempts,
      );
      return { productId, status: 'failed', message: outcome.reason };
    }

    // A row that arrived as nothing but a barcode now has a real name, so the
    // file it produces should carry that name rather than "Product_03600…".
    const resolved = applyFacts(product, outcome.facts);

    const fileName = buildFileName({
      name: resolved.name,
      brand: resolved.brand,
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
          status: outcome.needsReview ? ProductStatus.NEEDS_REVIEW : ProductStatus.SUCCEEDED,
          reviewReason: outcome.reviewReason?.slice(0, 500) ?? null,
          outputName: fileName,
          processedAt: new Date(),
          errorMessage: null,
          enrichment: outcome.enrichment as unknown as object,
          ...(outcome.facts ? { facts: outcome.facts as unknown as object } : {}),
          // Backfill only what the upload did not supply, so a discovered name
          // never overwrites what the customer explicitly told us.
          name: resolved.name,
          brand: resolved.brand,
          model: resolved.model,
          category: resolved.category,
          description: resolved.description,
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
    await failProduct(productId, product.batchId, message, null, undefined, running.attempts);
    return { productId, status: 'failed', message };
  }
}

/**
 * Record an empty row — and, while the ladder still has a rung left, put it
 * straight back in the queue at a higher effort rather than calling it failed.
 *
 * A row queued for another pass goes back to PENDING, not FAILED: the batch is
 * not finished, its failure counter must not move yet, and the customer should
 * not be shown a failure that is about to be revisited.
 */
async function failProduct(
  productId: string,
  batchId: string,
  message: string,
  enrichment: ProductEnrichment | null,
  facts: ProductFacts | undefined,
  attempts: number,
): Promise<void> {
  const retrying = attempts < EFFORT_LADDER.length;

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: productId },
      data: {
        status: retrying ? ProductStatus.PENDING : ProductStatus.FAILED,
        errorMessage: message.slice(0, 1000),
        processedAt: retrying ? null : new Date(),
        ...(enrichment ? { enrichment: enrichment as unknown as object } : {}),
        // Even a failed product is worth more with its details filled in.
        ...(facts ? { facts: facts as unknown as object } : {}),
      },
    });
    if (!retrying) {
      await tx.batch.update({
        where: { id: batchId },
        data: { processedCount: { increment: 1 }, failedCount: { increment: 1 } },
      });
    }
  });

  if (retrying) {
    try {
      await queue().enqueueProducts([{ productId, batchId, attempt: attempts + 1 }]);
      return;
    } catch (error) {
      // The row is PENDING with nothing coming to pick it up, which would hang
      // the batch forever — no error, no log, just a batch that never
      // completes. A failure the customer can see and retry is strictly better.
      const reason = error instanceof Error ? error.message : String(error);
      console.error('[pipeline] could not queue a retry', reason);
      await markFailed(productId, batchId, `${message} (retry could not be queued)`);
    }
  }

  await finaliseBatchIfDone(batchId);
}

/** Settle a row as failed and move the batch counters, with nothing else to try. */
async function markFailed(productId: string, batchId: string, message: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: productId },
      data: {
        status: ProductStatus.FAILED,
        errorMessage: message.slice(0, 1000),
        processedAt: new Date(),
      },
    });
    await tx.batch.update({
      where: { id: batchId },
      data: { processedCount: { increment: 1 }, failedCount: { increment: 1 } },
    });
  });
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

  // A row awaiting a decision produced an image, so it counts towards the
  // batch's successes; only an empty row is a failure.
  const [succeeded, failed, skipped] = await Promise.all([
    prisma.product.count({
      where: { batchId, status: { in: [ProductStatus.SUCCEEDED, ProductStatus.NEEDS_REVIEW] } },
    }),
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

interface ResolvedFields {
  name: string;
  brand: string | null;
  model: string | null;
  category: string | null;
  description: string | null;
}

/**
 * A name we generated from a barcode ("Product 036000291452") is a placeholder,
 * not information. When a lookup tells us what the product really is, that wins
 * — but only over a placeholder or a blank, never over a supplier's own words.
 */
export function applyFacts(
  product: {
    name: string;
    brand: string | null;
    model: string | null;
    category: string | null;
    description: string | null;
    upc: string | null;
    sku: string | null;
  },
  facts?: ProductFacts,
): ResolvedFields {
  const placeholder =
    (product.upc !== null && product.name.trim() === `Product ${product.upc}`) ||
    (product.sku !== null && product.name.trim() === `Product ${product.sku}`) ||
    /^product\s+[\d-]+$/i.test(product.name.trim());

  return {
    name: placeholder && facts?.title ? facts.title : product.name,
    brand: product.brand ?? facts?.brand ?? null,
    model: product.model ?? facts?.model ?? null,
    category: product.category ?? facts?.category ?? null,
    description: product.description ?? facts?.description ?? null,
  };
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
