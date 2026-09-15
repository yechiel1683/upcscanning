import { LedgerReason, ProductStatus } from '@prisma/client';

import { fail, notFound, ok, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';
import { finaliseBatchIfDone } from '@/server/pipeline/run-product-job';
import { storage } from '@/server/storage';

type Params = { params: Promise<{ id: string }> };

/**
 * Accept or reject an image the pipeline was not confident about.
 *
 * A row that only cleared the relaxed bar of a final retry is a judgement, not
 * an answer, and the person filling the catalog is the one qualified to make
 * it. Confirming settles it; rejecting empties the row rather than leaving a
 * picture nobody vouched for sitting in an export.
 */
export const POST = withUser(async (user, request, { params }: Params) => {
  const { id } = await params;

  const product = await prisma.product.findFirst({
    where: { id, batch: { userId: user.id } },
    select: { id: true, batchId: true, status: true },
  });
  if (!product) return notFound('Product');
  if (product.status !== ProductStatus.NEEDS_REVIEW) {
    return fail('This product is not waiting on a decision.', 409);
  }

  let accept = true;
  try {
    const body = (await request.json()) as { accept?: unknown };
    if (typeof body.accept === 'boolean') accept = body.accept;
  } catch {
    // An empty body means "yes", which is what the button sends.
  }

  if (accept) {
    await prisma.product.update({
      where: { id },
      data: { status: ProductStatus.SUCCEEDED, reviewReason: null },
    });
  } else {
    // Take the bytes with it. A rejected image is one nobody will ever ask for
    // again, and leaving it behind is a bill for storing a mistake.
    const assets = await prisma.imageAsset.findMany({
      where: { productId: id },
      select: { storageKey: true },
    });
    await Promise.all(
      assets.map((asset) =>
        storage()
          .delete(asset.storageKey)
          .catch((error: unknown) => {
            // An orphaned object is untidy, not a reason to refuse the
            // rejection the customer just made.
            console.warn('[confirm] could not delete rejected image', error);
          }),
      ),
    );

    await prisma.$transaction(async (tx) => {
      await tx.imageAsset.deleteMany({ where: { productId: id } });
      await tx.product.update({
        where: { id },
        data: {
          status: ProductStatus.FAILED,
          reviewReason: null,
          outputName: null,
          errorMessage: 'You rejected the image that was found for this product.',
        },
      });

      // Give the credit back. The row succeeded, so it was charged — and the
      // customer has just told us the picture was wrong. Everywhere else in
      // this pipeline a row that produces nothing usable costs nothing, and a
      // rejected image is the clearest case of that there is. Charging for it
      // would make the review flow something people avoid using.
      await tx.creditLedger.create({
        data: {
          userId: user.id,
          delta: 1,
          reason: LedgerReason.REFUND_FAILED,
          productId: id,
          note: 'Image rejected on review',
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { credits: { increment: 1 } },
      });
      // The batch counters move too: this is a failure now, not a success.
      await tx.batch.update({
        where: { id: product.batchId },
        data: { successCount: { decrement: 1 }, failedCount: { increment: 1 } },
      });
    });
  }

  // The batch counters move either way: a rejection turns an image into a
  // failure, and both change what the summary should say.
  await finaliseBatchIfDone(product.batchId);

  return ok({ id, status: accept ? ProductStatus.SUCCEEDED : ProductStatus.FAILED });
});
