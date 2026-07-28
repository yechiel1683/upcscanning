import { fail, handleError, notFound } from '@/server/api/respond';
import { currentGuest } from '@/server/guest/session';
import { findGuestImage } from '@/server/guest/store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** Serve a guest's rendered image from memory, scoped to their session. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const session = await currentGuest();
    if (!session) return fail('Your guest session has expired.', 401);

    const { id } = await params;
    const image = findGuestImage(session, id);
    if (!image) return notFound('Image');

    return new Response(new Uint8Array(image.buffer), {
      headers: {
        'content-type': image.mimeType,
        'content-length': String(image.buffer.byteLength),
        'cache-control': 'private, max-age=3600',
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
