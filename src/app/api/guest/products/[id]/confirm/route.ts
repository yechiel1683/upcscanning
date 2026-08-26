import { currentGuest } from '@/server/guest/session';
import { fail, handleError, notFound, ok } from '@/server/api/respond';
import { renderAlternative } from '@/server/pipeline/process-product';
import { findGuestProduct, newImageId, settleGuestBatch } from '@/server/guest/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Settle an image the pipeline was not confident about.
 *
 * A row that only cleared the relaxed bar of a final retry is a judgement, not
 * an answer, and the person filling the catalog is the one qualified to make
 * it. Three ways to settle it:
 *
 *  - accept  — it is the right product, file it
 *  - swap    — the other candidate is the right one, use that instead
 *  - reject  — none of them is right, empty the row
 *
 * The swap matters because rejecting a near-miss when a better picture was
 * sitting second on the list throws away the answer along with the mistake.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await currentGuest();
    if (!session) return fail('Your guest session has expired. Start a new one.', 401);

    const { id } = await params;
    const found = findGuestProduct(session, id);
    if (!found) return notFound('Product');
    const { product, batch } = found;

    let accept = true;
    let useUrl: string | null = null;
    try {
      const body = (await request.json()) as { accept?: unknown; use?: unknown };
      if (typeof body.accept === 'boolean') accept = body.accept;
      if (typeof body.use === 'string') useUrl = body.use;
    } catch {
      // An empty body means "yes", which is what the button sends.
    }

    if (useUrl) {
      // Only a URL this product's own pipeline already downloaded, scored and
      // cleared. Rendering an arbitrary URL on request would make this endpoint
      // a way to point the server at anything.
      const chosen = product.alternatives.find((option) => option.sourceUrl === useUrl);
      if (!chosen) return fail('That is not one of the images found for this product.', 400);
      if (!product.image) return fail('This product has no image to replace.', 409);

      const { render, qualityScore } = await renderAlternative(chosen.sourceUrl, batch.options);

      // Captured before the overwrite: this is the image being swapped away
      // from, and it is what the customer needs to get back to.
      const previous = {
        sourceUrl: product.image.sourceUrl,
        provider: product.image.provider,
        matchScore: product.image.matchScore,
        qualityScore: product.image.qualityScore,
      };

      product.image = {
        ...product.image,
        id: newImageId(),
        mimeType: render.mimeType,
        width: render.width,
        height: render.height,
        bytes: render.bytes,
        provider: chosen.provider,
        sourceUrl: chosen.sourceUrl,
        matchScore: chosen.matchScore,
        qualityScore,
        buffer: render.buffer,
      };
      // The one just swapped away from becomes the alternative, so a wrong
      // choice can be undone without re-running the product.
      product.alternatives = [
        ...(previous.sourceUrl
          ? [
              {
                sourceUrl: previous.sourceUrl,
                provider: previous.provider ?? 'unknown',
                matchScore: previous.matchScore,
                qualityScore: previous.qualityScore,
              },
            ]
          : []),
        ...product.alternatives.filter((option) => option.sourceUrl !== chosen.sourceUrl),
      ].slice(0, 2);
      product.status = 'SUCCEEDED';
      product.reviewReason = null;
      product.errorMessage = null;
    } else if (accept) {
      product.status = 'SUCCEEDED';
      product.reviewReason = null;
    } else {
      product.status = 'FAILED';
      product.errorMessage = 'You rejected the image that was found for this product.';
      product.reviewReason = null;
      product.image = null;
      product.outputName = null;
    }

    // A ZIP built before this decision no longer reflects it. Dropping the
    // cached copy costs one rebuild; keeping it would hand someone the picture
    // they just rejected.
    batch.zip = null;
    settleGuestBatch(batch);

    return ok({ id: product.id, status: product.status });
  } catch (error) {
    return handleError(error);
  }
}
