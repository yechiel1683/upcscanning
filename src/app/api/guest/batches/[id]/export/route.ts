import { fail, handleError, notFound } from '@/server/api/respond';
import { buildGuestZip } from '@/server/guest/run';
import { currentGuest } from '@/server/guest/session';
import { findGuestBatch } from '@/server/guest/store';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/**
 * Build and stream the guest's ZIP in one request.
 *
 * Accounts queue an export because a batch can hold thousands of images; a
 * guest batch is capped small enough to build inline, which removes a polling
 * round-trip from the path someone is using to evaluate the product.
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const session = await currentGuest();
    if (!session) return fail('Your guest session has expired. Start a new one.', 401);

    const { id } = await params;
    const batch = findGuestBatch(session, id);
    if (!batch) return notFound('Batch');

    const ready = batch.products.filter((product) => product.status === 'SUCCEEDED');
    if (ready.length === 0) return fail('There are no finished images to export yet.', 409);

    // Cached on the batch so a second download does not rebuild it.
    const zip = batch.zip ?? (await buildGuestZip(batch));
    batch.zip = zip;

    return new Response(new Uint8Array(zip.buffer), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${zip.fileName}"`,
        'content-length': String(zip.buffer.byteLength),
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
