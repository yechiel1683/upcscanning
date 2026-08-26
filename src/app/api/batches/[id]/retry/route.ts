import { BatchStatus, ProductStatus } from '@prisma/client';
import { z } from 'zod';

import { fail, handleError, notFound, ok, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';
import { queue } from '@/server/queue';

type Params = { params: Promise<{ id: string }> };

const schema = z.object({
  /** Retry specific products; omit to retry every failed product in the batch. */
  productIds: z.array(z.string()).max(5000).optional(),
  /** Allow AI generation on the retry even if the original run disallowed it. */
  allowAiGeneration: z.boolean().optional(),
});

export const POST = withUser(async (user, request, { params }: Params) => {
  try {
    const { id } = await params;

    const batch = await prisma.batch.findFirst({
      where: { id, userId: user.id },
      select: { id: true, renderOptions: true },
    });
    if (!batch) return notFound('Batch');

    const body = schema.parse(await request.json().catch(() => ({})));

    const targets = await prisma.product.findMany({
      where: {
        batchId: id,
        status: { in: [ProductStatus.FAILED, ProductStatus.SKIPPED] },
        ...(body.productIds?.length ? { id: { in: body.productIds } } : {}),
      },
      select: { id: true, attempts: true },
    });

    if (targets.length === 0) {
      return fail('There are no failed products to retry in this batch.', 409);
    }

    if (user.credits < targets.length) {
      return fail(
        `Retrying ${targets.length} product(s) needs ${targets.length} credits and you have ${user.credits}.`,
        402,
        { required: targets.length, available: user.credits },
      );
    }

    // Flipping generation on is the single most common reason a retry succeeds
    // where the first run did not, so let the caller change it here.
    const renderOptions =
      body.allowAiGeneration === undefined
        ? undefined
        : {
            ...(typeof batch.renderOptions === 'object' && batch.renderOptions
              ? (batch.renderOptions as Record<string, unknown>)
              : {}),
            allowAiGeneration: body.allowAiGeneration,
          };

    const ids = targets.map((t) => t.id);

    await prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { id: { in: ids } },
        data: { status: ProductStatus.PENDING, errorMessage: null, processedAt: null },
      });

      // Reset the aggregate counters for the rows going back into the queue.
      const failedAgain = await tx.product.count({
        where: { batchId: id, status: ProductStatus.FAILED },
      });

      await tx.batch.update({
        where: { id },
        data: {
          status: BatchStatus.PROCESSING,
          completedAt: null,
          failedCount: failedAgain,
          processedCount: { decrement: Math.min(ids.length, Number.MAX_SAFE_INTEGER) },
          ...(renderOptions ? { renderOptions } : {}),
        },
      });
    });

    // The attempt number keeps this job distinct from the completed one it is
    // replacing, which shares the product id and would otherwise swallow it.
    await queue().enqueueProducts(
      targets.map((target) => ({
        productId: target.id,
        batchId: id,
        attempt: target.attempts + 1,
      })),
    );

    return ok({ retrying: ids.length });
  } catch (error) {
    return handleError(error);
  }
});
