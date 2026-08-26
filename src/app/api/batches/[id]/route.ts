import { BatchStatus, ProductStatus } from '@prisma/client';

import { handleError, notFound, ok, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';

type Params = { params: Promise<{ id: string }> };

/** Batch detail plus live counters — polled by the dashboard for progress. */
export const GET = withUser(async (user, _request, { params }: Params) => {
  const { id } = await params;

  const batch = await prisma.batch.findFirst({
    where: { id, userId: user.id },
    include: {
      exports: { orderBy: { createdAt: 'desc' }, take: 5 },
      _count: { select: { products: true } },
    },
  });
  if (!batch) return notFound('Batch');

  // Counters on the batch row can lag behind a crashed worker; group-by is the
  // authoritative view and is cheap enough to run on every poll.
  const grouped = await prisma.product.groupBy({
    by: ['status'],
    where: { batchId: id },
    _count: { _all: true },
  });

  const counts: Record<ProductStatus, number> = {
    PENDING: 0,
    PROCESSING: 0,
    SUCCEEDED: 0,
    NEEDS_REVIEW: 0,
    FAILED: 0,
    SKIPPED: 0,
  };
  for (const row of grouped) counts[row.status] = row._count._all;

  const total = batch._count.products;
  const finished =
    counts.SUCCEEDED + counts.NEEDS_REVIEW + counts.FAILED + counts.SKIPPED;

  const imageKinds = await prisma.imageAsset.groupBy({
    by: ['kind'],
    where: { product: { batchId: id } },
    _count: { _all: true },
  });

  return ok({
    batch: {
      id: batch.id,
      name: batch.name,
      status: batch.status,
      originalFile: batch.originalFile,
      fileSizeBytes: batch.fileSizeBytes,
      columnMapping: batch.columnMapping,
      renderOptions: batch.renderOptions,
      createdAt: batch.createdAt,
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
      errorMessage: batch.errorMessage,
    },
    progress: {
      total,
      finished,
      percent: total === 0 ? 0 : Math.round((finished / total) * 100),
      ...counts,
      isRunning:
        batch.status === BatchStatus.PROCESSING ||
        batch.status === BatchStatus.QUEUED ||
        counts.PENDING + counts.PROCESSING > 0,
    },
    imageKinds: Object.fromEntries(imageKinds.map((k) => [k.kind, k._count._all])),
    exports: batch.exports.map((e) => ({
      id: e.id,
      status: e.status,
      fileName: e.fileName,
      bytes: e.bytes,
      imageCount: e.imageCount,
      createdAt: e.createdAt,
      errorMessage: e.errorMessage,
    })),
  });
});

/** Cancel a running batch, or delete a finished one along with its images. */
export const DELETE = withUser(async (user, _request, { params }: Params) => {
  try {
    const { id } = await params;
    const batch = await prisma.batch.findFirst({
      where: { id, userId: user.id },
      select: { id: true, status: true },
    });
    if (!batch) return notFound('Batch');

    const running =
      batch.status === BatchStatus.PROCESSING || batch.status === BatchStatus.QUEUED;

    if (running) {
      // Cancel rather than delete: in-flight jobs check this status and stop.
      await prisma.$transaction([
        prisma.batch.update({
          where: { id },
          data: { status: BatchStatus.CANCELLED, completedAt: new Date() },
        }),
        prisma.product.updateMany({
          where: { batchId: id, status: ProductStatus.PENDING },
          data: { status: ProductStatus.SKIPPED, errorMessage: 'Batch cancelled' },
        }),
      ]);
      return ok({ cancelled: true });
    }

    // Cascades remove products, candidates, image rows, and exports.
    await prisma.batch.delete({ where: { id } });
    return ok({ deleted: true });
  } catch (error) {
    return handleError(error);
  }
});
