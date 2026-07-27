import { ExportStatus, ProductStatus } from '@prisma/client';

import { fail, handleError, notFound, ok, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';
import { queue } from '@/server/queue';

type Params = { params: Promise<{ id: string }> };

/** Kick off a ZIP build for the batch. */
export const POST = withUser(async (user, _request, { params }: Params) => {
  try {
    const { id } = await params;

    const batch = await prisma.batch.findFirst({
      where: { id, userId: user.id },
      select: { id: true, name: true },
    });
    if (!batch) return notFound('Batch');

    const ready = await prisma.product.count({
      where: { batchId: id, status: ProductStatus.SUCCEEDED },
    });
    if (ready === 0) {
      return fail('There are no finished images to export yet.', 409);
    }

    // Reuse an export that is already being built for this batch rather than
    // queuing a second identical job.
    const inFlight = await prisma.export.findFirst({
      where: { batchId: id, status: { in: [ExportStatus.PENDING, ExportStatus.BUILDING] } },
      orderBy: { createdAt: 'desc' },
    });
    if (inFlight) return ok({ export: summarise(inFlight), reused: true });

    const fileName = `${slug(batch.name)}_images.zip`;
    const record = await prisma.export.create({
      data: { batchId: id, fileName, status: ExportStatus.PENDING },
    });

    await queue().enqueueExport({ exportId: record.id, batchId: id });

    return ok({ export: summarise(record) }, { status: 202 });
  } catch (error) {
    return handleError(error);
  }
});

/** List exports for the batch, newest first. */
export const GET = withUser(async (user, _request, { params }: Params) => {
  const { id } = await params;

  const batch = await prisma.batch.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!batch) return notFound('Batch');

  const exports = await prisma.export.findMany({
    where: { batchId: id },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  return ok({ exports: exports.map(summarise) });
});

function summarise(record: {
  id: string;
  status: ExportStatus;
  fileName: string;
  bytes: number | null;
  imageCount: number;
  errorMessage: string | null;
  createdAt: Date;
}) {
  return {
    id: record.id,
    status: record.status,
    fileName: record.fileName,
    bytes: record.bytes,
    imageCount: record.imageCount,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
    downloadUrl: record.status === ExportStatus.READY ? `/api/exports/${record.id}/download` : null,
  };
}

function slug(name: string): string {
  return name.replace(/[^\w-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'catalog';
}
