import { Readable } from 'node:stream';

import { ExportStatus } from '@prisma/client';

import { fail, handleError, notFound, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';
import { storage } from '@/server/storage';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };

/** Stream a finished ZIP. Streaming matters: these run to hundreds of MB. */
export const GET = withUser(async (user, _request, { params }: Params) => {
  try {
    const { id } = await params;

    const record = await prisma.export.findFirst({
      where: { id, batch: { userId: user.id } },
      select: { id: true, status: true, storageKey: true, fileName: true, bytes: true },
    });
    if (!record) return notFound('Export');

    if (record.status !== ExportStatus.READY || !record.storageKey) {
      return fail(
        record.status === ExportStatus.FAILED
          ? 'That export failed to build. Start a new one.'
          : 'That export is still being built. Try again in a moment.',
        409,
      );
    }

    const stream = await storage().stream(record.storageKey);
    const webStream = Readable.toWeb(
      stream instanceof Readable ? stream : Readable.from(stream),
    ) as ReadableStream;

    return new Response(webStream, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${record.fileName.replace(/"/g, '')}"`,
        ...(record.bytes ? { 'content-length': String(record.bytes) } : {}),
        'cache-control': 'private, max-age=0, must-revalidate',
      },
    });
  } catch (error) {
    return handleError(error);
  }
});
