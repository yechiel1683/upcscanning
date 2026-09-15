import { z } from 'zod';

import { DEFAULT_RENDER_OPTIONS, renderOptionsSchema, type RenderOptions } from '@/lib/types';
import { limit } from '@/server/api/guard';
import { fail, handleError, ok } from '@/server/api/respond';
import { readUploadForm, UploadError } from '@/server/api/upload';
import { currentGuest, startGuest } from '@/server/guest/session';
import { runGuestBatch } from '@/server/guest/run';
import { releaseGuestImages, reserveGuestImages } from '@/server/guest/budget';
import { createGuestBatch, GUEST_MAX_PRODUCTS_PER_BATCH } from '@/server/guest/store';
import { parseBarcodeList } from '@/server/ingest/barcode-list';
import { mappingIsUsable } from '@/server/ingest/column-mapper';
import { IngestError, parseSpreadsheet } from '@/server/ingest/parser';

export const runtime = 'nodejs';
export const maxDuration = 300;

const barcodeSchema = z.object({
  barcodes: z.string().min(1).max(200_000),
  name: z.string().trim().min(1).max(200).optional(),
  options: renderOptionsSchema.partial().optional(),
});

/**
 * Create and run a guest batch.
 *
 * Processing happens inline rather than through the queue: a guest session has
 * no durable store to resume from, so a job that outlived the request would
 * have nowhere to write its result.
 */
export async function POST(request: Request) {
  try {
    // Before anything is parsed or a session is handed out. This endpoint is
    // public, unauthenticated, and spends real money per row.
    const refused = limit(request, 'guestBatch');
    if (refused) return refused;

    // A guest who posts without having started a session gets one, so the
    // "try it" path is a single click rather than two.
    const session = (await currentGuest()) ?? (await startGuest());

    const isJson = (request.headers.get('content-type') ?? '').includes('application/json');

    let parsed;
    let sourceName: string;
    let overrides: Partial<RenderOptions> | undefined;
    let batchName: string;

    if (isJson) {
      const body = barcodeSchema.parse(await request.json());
      parsed = parseBarcodeList(body.barcodes, GUEST_MAX_PRODUCTS_PER_BATCH);
      sourceName = 'pasted-barcodes.txt';
      overrides = body.options;
      batchName = body.name ?? `Barcode list — ${parsed.products.length} items`;
    } else {
      const form = await readUploadForm(request);
      parsed = await parseSpreadsheet(form.buffer, form.fileName, {
        mappingOverride: form.mapping,
        maxProducts: GUEST_MAX_PRODUCTS_PER_BATCH,
      });
      sourceName = form.fileName;
      overrides = form.options;
      batchName = form.name || form.fileName.replace(/\.[^.]+$/, '');
    }

    if (!mappingIsUsable(parsed.mapping)) {
      return fail(
        'We could not find a product name or barcode column in that file.',
        422,
        { headers: parsed.headers, mapping: parsed.mapping },
      );
    }

    if (parsed.products.length === 0) {
      return fail(
        isJson
          ? 'No usable barcodes were found. Paste one barcode per line.'
          : 'No usable product rows were found in that file.',
        422,
        { skipped: parsed.skipped.slice(0, 20) },
      );
    }

    if (session.credits < parsed.products.length) {
      return fail(
        `A guest session includes ${session.credits} more image(s). ` +
          'Create an account to process more.',
        402,
        { required: parsed.products.length, available: session.credits },
      );
    }

    // Claim today's share of the trial budget before starting, not after
    // finishing: a counter that only moves on completion is behind by however
    // many batches are in flight, which is the window a flood walks through.
    const budget = reserveGuestImages(parsed.products.length);
    if (!budget.allowed) {
      return fail(budget.message ?? 'The free trial is full for today.', 429, {
        remaining: budget.remaining,
        dailyLimit: budget.limit,
      });
    }

    const batch = createGuestBatch(session, {
      name: batchName,
      originalFile: sourceName,
      options: { ...DEFAULT_RENDER_OPTIONS, ...(overrides ?? {}) },
      products: parsed.products,
    });

    // Kick off without awaiting: the client polls for progress, exactly as it
    // does for an account batch.
    void runGuestBatch(session, batch).catch((error) => {
      console.error('[guest] batch failed', error);
      // Nothing was processed, so nothing was spent. Holding the reservation
      // would close the trial early for everyone else.
      releaseGuestImages(parsed.products.length);
    });

    return ok(
      {
        batch: { id: batch.id, name: batch.name, totalProducts: batch.products.length },
        mapping: parsed.mapping,
        skipped: parsed.skipped.slice(0, 20),
        warnings: parsed.warnings.slice(0, 20),
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof UploadError) return fail(error.message, error.status);
    if (error instanceof IngestError) return fail(error.message, 422);
    return handleError(error);
  }
}
