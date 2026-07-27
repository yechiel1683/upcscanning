import { handleError, notFound, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';
import { storage } from '@/server/storage';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/**
 * Serve a rendered product image.
 *
 * Access is scoped to the owning user — images are customer catalog assets and
 * should not be enumerable by anyone holding an id.
 */
export const GET = withUser(async (user, _request, { params }: Params) => {
  try {
    const { id } = await params;

    const image = await prisma.imageAsset.findFirst({
      where: { id, product: { batch: { userId: user.id } } },
      select: { storageKey: true, mimeType: true, fileName: true, bytes: true },
    });
    if (!image) return notFound('Image');

    const buffer = await storage().get(image.storageKey);

    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': image.mimeType,
        'content-length': String(buffer.byteLength),
        'content-disposition': `inline; filename="${image.fileName.replace(/"/g, '')}"`,
        // Rendered output is immutable: a re-render creates a new row.
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (error) {
    return handleError(error);
  }
});
