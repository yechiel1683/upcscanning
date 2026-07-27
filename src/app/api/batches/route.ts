import { BatchStatus, ProductStatus } from '@prisma/client';

import { env } from '@/lib/env';
import { DEFAULT_RENDER_OPTIONS } from '@/lib/types';
import { fail, handleError, ok, withUser } from '@/server/api/respond';
import { readUploadForm, UploadError } from '@/server/api/upload';
import { prisma } from '@/server/db';
import { mappingIsUsable } from '@/server/ingest/column-mapper';
import { IngestError, parseSpreadsheet } from '@/server/ingest/parser';
import { queue } from '@/server/queue';
import { keys, storage } from '@/server/storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** List the signed-in user's batches, newest first. */
export const GET = withUser(async (user, request) => {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);
  const cursor = url.searchParams.get('cursor');

  const batches = await prisma.batch.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      name: true,
      status: true,
      originalFile: true,
      totalProducts: true,
      processedCount: true,
      successCount: true,
      failedCount: true,
      createdAt: true,
      completedAt: true,
    },
  });

  const hasMore = batches.length > limit;
  return ok({
    batches: hasMore ? batches.slice(0, limit) : batches,
    nextCursor: hasMore ? batches[limit - 1]?.id : null,
  });
});

/**
 * Create a batch from an uploaded spreadsheet and start processing.
 *
 * Products are inserted in one shot and then handed to the queue; the response
 * returns as soon as the work is scheduled rather than waiting for images, so
 * a 1,000-row upload still answers in a couple of seconds.
 */
export const POST = withUser(async (user, request) => {
  try {
    const form = await readUploadForm(request);
    const config = env();

    const parsed = await parseSpreadsheet(form.buffer, form.fileName, {
      mappingOverride: form.mapping,
      maxProducts: config.MAX_PRODUCTS_PER_BATCH,
    });

    if (!mappingIsUsable(parsed.mapping)) {
      return fail(
        'We could not find a product name or barcode column. Map at least one of them and upload again.',
        422,
        { headers: parsed.headers, mapping: parsed.mapping },
      );
    }

    if (parsed.products.length === 0) {
      return fail(
        'No usable product rows were found in that file. Every row was empty or a duplicate.',
        422,
        { skipped: parsed.skipped.slice(0, 20) },
      );
    }

    if (user.credits < parsed.products.length) {
      return fail(
        `This batch needs ${parsed.products.length} credits and you have ${user.credits}. ` +
          'Remove some rows or top up to continue.',
        402,
        { required: parsed.products.length, available: user.credits },
      );
    }

    const renderOptions = { ...DEFAULT_RENDER_OPTIONS, ...(form.options ?? {}) };

    const batch = await prisma.batch.create({
      data: {
        userId: user.id,
        name: form.name || form.fileName.replace(/\.[^.]+$/, ''),
        originalFile: form.fileName,
        fileSizeBytes: form.buffer.byteLength,
        status: BatchStatus.QUEUED,
        columnMapping: parsed.mapping,
        renderOptions,
        totalProducts: parsed.products.length,
        skippedCount: parsed.skipped.length,
      },
    });

    // Keep the source file: it is the only way to explain a mapping decision
    // after the fact, and it makes a re-run possible without a re-upload.
    await storage()
      .put(keys.upload(batch.id, form.fileName), form.buffer, 'application/octet-stream')
      .catch((error) => console.warn('[upload] could not archive source file', error));

    await prisma.product.createMany({
      data: parsed.products.map((product) => ({
        batchId: batch.id,
        rowNumber: product.rowNumber,
        sku: product.sku ?? null,
        upc: product.upc ?? null,
        name: product.name,
        brand: product.brand ?? null,
        model: product.model ?? null,
        description: product.description ?? null,
        category: product.category ?? null,
        price: product.price ?? null,
        status: ProductStatus.PENDING,
        // The image URL rides along in `extra` so the pipeline can prefer the
        // supplier's own photo without another schema column.
        extra: {
          ...product.extra,
          ...(product.specifications ? { __specifications: product.specifications } : {}),
          ...(product.imageUrl ? { __imageUrl: product.imageUrl } : {}),
        },
      })),
    });

    const created = await prisma.product.findMany({
      where: { batchId: batch.id },
      select: { id: true },
    });

    await queue().enqueueProducts(created.map((p) => ({ productId: p.id, batchId: batch.id })));

    return ok(
      {
        batch: {
          id: batch.id,
          name: batch.name,
          status: batch.status,
          totalProducts: batch.totalProducts,
        },
        mapping: parsed.mapping,
        skipped: parsed.skipped.slice(0, 20),
        warnings: parsed.warnings.slice(0, 20),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof UploadError) return fail(error.message, error.status);
    if (error instanceof IngestError) return fail(error.message, 422);
    return handleError(error);
  }
});
