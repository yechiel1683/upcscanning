import { fail, handleError, notFound, ok } from '@/server/api/respond';
import { currentGuest } from '@/server/guest/session';
import { findGuestBatch } from '@/server/guest/store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Status and products for a guest batch, in one response. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const session = await currentGuest();
    if (!session) return fail('Your guest session has expired. Start a new one.', 401);

    const { id } = await params;
    const batch = findGuestBatch(session, id);
    if (!batch) return notFound('Batch');

    const counts = { PENDING: 0, PROCESSING: 0, SUCCEEDED: 0, FAILED: 0 };
    for (const product of batch.products) counts[product.status] += 1;

    const finished = counts.SUCCEEDED + counts.FAILED;
    const total = batch.products.length;

    return ok({
      batch: {
        id: batch.id,
        name: batch.name,
        originalFile: batch.originalFile,
        status: batch.status,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
      },
      progress: {
        total,
        finished,
        percent: total === 0 ? 0 : Math.round((finished / total) * 100),
        ...counts,
        SKIPPED: 0,
        isRunning: counts.PENDING + counts.PROCESSING > 0,
      },
      credits: session.credits,
      zipReady: Boolean(batch.zip),
      products: batch.products.map((product) => ({
        id: product.id,
        rowNumber: product.rowNumber,
        sku: product.sku ?? null,
        upc: product.upc ?? null,
        name: product.name,
        brand: product.brand ?? null,
        status: product.status,
        errorMessage: product.errorMessage,
        outputName: product.outputName,
        detailsSource: product.facts?.source ?? null,
        image: product.image
          ? {
              id: product.image.id,
              kind: product.image.kind,
              fileName: product.image.fileName,
              width: product.image.width,
              height: product.image.height,
              bytes: product.image.bytes,
              provider: product.image.provider,
              matchScore: product.image.matchScore,
              qualityScore: product.image.qualityScore,
            }
          : null,
      })),
    });
  } catch (error) {
    return handleError(error);
  }
}
