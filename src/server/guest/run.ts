import { ImageSourceKind } from '@prisma/client';

import { buildFileName } from '@/server/images/naming';
import { processProduct } from '@/server/pipeline/process-product';
import { applyFacts } from '@/server/pipeline/run-product-job';
import { buildZip, type ZipRow } from '@/server/export/build-zip';
import {
  newImageId,
  settleGuestBatch,
  type GuestBatch,
  type GuestSession,
} from './store';

/**
 * The guest job runner.
 *
 * The same pipeline an account uses — processProduct is shared verbatim — with
 * results written to memory instead of Postgres and S3. Keeping the engine
 * common is the point: a guest is evaluating the real thing, so a guest run
 * that quietly used a simpler path would be a demo, not a trial.
 */

/** Guests run with modest concurrency: this is the web process, not a worker. */
const GUEST_CONCURRENCY = 3;

export async function runGuestBatch(session: GuestSession, batch: GuestBatch): Promise<void> {
  batch.status = 'PROCESSING';

  const queue = [...batch.products];
  const workers = Array.from({ length: Math.min(GUEST_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const product = queue.shift();
      if (!product) return;

      product.status = 'PROCESSING';
      try {
        const outcome = await processProduct({
          product: {
            id: product.id,
            rowNumber: product.rowNumber,
            name: product.name,
            sku: product.sku ?? null,
            upc: product.upc ?? null,
            brand: product.brand ?? null,
            model: product.model ?? null,
            description: product.description ?? null,
            specifications: product.specifications ?? null,
            category: product.category ?? null,
            imageUrl: product.imageUrl ?? null,
          },
          options: batch.options,
        });

        if (outcome.status === 'failed') {
          product.status = 'FAILED';
          product.errorMessage = outcome.reason;
          product.facts = outcome.facts ?? null;
          continue;
        }

        // Same backfill rule as an account: a discovered name replaces a
        // placeholder we invented, never something the upload supplied.
        const resolved = applyFacts(
          {
            name: product.name,
            brand: product.brand ?? null,
            model: product.model ?? null,
            category: product.category ?? null,
            description: product.description ?? null,
            upc: product.upc ?? null,
            sku: product.sku ?? null,
          },
          outcome.facts,
        );

        const fileName = buildFileName({
          name: resolved.name,
          brand: resolved.brand,
          sku: product.sku ?? null,
          upc: product.upc ?? null,
          rowNumber: product.rowNumber,
          format: batch.options.format,
        });

        product.name = resolved.name;
        product.brand = resolved.brand ?? undefined;
        product.model = resolved.model ?? undefined;
        product.category = resolved.category ?? undefined;
        product.description = resolved.description ?? undefined;
        product.facts = outcome.facts ?? null;
        product.outputName = fileName;
        product.status = 'SUCCEEDED';
        product.errorMessage = null;
        product.image = {
          id: newImageId(),
          kind:
            outcome.kind === 'AI_GENERATED'
              ? ImageSourceKind.AI_GENERATED
              : outcome.kind === 'USER_PROVIDED'
                ? ImageSourceKind.USER_PROVIDED
                : ImageSourceKind.REAL,
          fileName,
          mimeType: outcome.render.mimeType,
          width: outcome.render.width,
          height: outcome.render.height,
          bytes: outcome.render.bytes,
          provider: outcome.provider,
          sourceUrl: outcome.sourceUrl ?? null,
          matchScore: outcome.matchScore,
          qualityScore: outcome.qualityScore,
          buffer: outcome.render.buffer,
        };

        session.credits = Math.max(0, session.credits - 1);
      } catch (error) {
        product.status = 'FAILED';
        product.errorMessage = error instanceof Error ? error.message : String(error);
      }
    }
  });

  await Promise.all(workers);
  settleGuestBatch(batch);
}

/** Build the guest's ZIP from memory, using the shared deliverable format. */
export async function buildGuestZip(batch: GuestBatch): Promise<{
  fileName: string;
  buffer: Buffer;
  imageCount: number;
}> {
  const rows: ZipRow[] = batch.products.map((product) => ({
    rowNumber: product.rowNumber,
    sku: product.sku ?? null,
    upc: product.upc ?? null,
    name: product.name,
    brand: product.brand ?? null,
    model: product.model ?? null,
    category: product.category ?? null,
    description: product.description ?? null,
    price: product.price ?? null,
    facts: product.facts,
    succeeded: product.status === 'SUCCEEDED',
    errorMessage: product.errorMessage,
    image: product.image
      ? {
          id: product.image.id,
          kind: product.image.kind,
          fileName: product.image.fileName,
          width: product.image.width,
          height: product.image.height,
          provider: product.image.provider,
          sourceUrl: product.image.sourceUrl,
          matchScore: product.image.matchScore,
          qualityScore: product.image.qualityScore,
          read: async () => product.image!.buffer,
        }
      : null,
  }));

  const { buffer, imageCount } = await buildZip({
    batchName: batch.name,
    createdAt: batch.createdAt,
    rows,
    notice:
      'Produced in a guest session. Nothing was saved on the server — this ZIP is\n' +
      'the only copy. Create an account to keep your batches and images.',
  });

  const fileName = `${batch.name.replace(/[^\w-]+/g, '_').replace(/^_|_$/g, '') || 'catalog'}_images.zip`;
  return { fileName, buffer, imageCount };
}
