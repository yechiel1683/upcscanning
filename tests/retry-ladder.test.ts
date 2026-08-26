import { inflateRawSync } from 'node:zlib';

import { ImageSourceKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { DEFAULT_RENDER_OPTIONS } from '@/lib/types';
import { buildZip, type ZipRow } from '@/server/export/build-zip';
import { EFFORT, EFFORT_LADDER, effortForAttempt } from '@/server/pipeline/process-product';
import {
  GUEST_CREDITS,
  GUEST_MAX_PRODUCTS_PER_BATCH,
  createGuestBatch,
  createGuestSession,
  findGuestProduct,
  guestBytesInUse,
  guestSessionCount,
  resetGuestStore,
  settleGuestBatch,
} from '@/server/guest/store';

/**
 * A row that comes back empty is not finished being worked on. The pipeline
 * stops early by design — it takes the first good image and moves on — so a
 * first-pass failure usually means it stopped too early, not that no photograph
 * of the product exists.
 *
 * These cover the parts of that which can go wrong quietly: a ladder that never
 * terminates, a "retry" that repeats the same request, and a raised batch limit
 * that quietly quadruples what one visitor can pin in this process's memory.
 */

function products(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    rowNumber: i + 1,
    upc: `03600029145${i}`,
    name: `Product ${i}`,
    extra: {},
  }));
}

describe('guest allowance', () => {
  it('accepts a hundred products in one go', () => {
    expect(GUEST_MAX_PRODUCTS_PER_BATCH).toBe(100);
    expect(GUEST_CREDITS).toBe(100);
  });

  it('holds the whole batch without losing rows', () => {
    resetGuestStore();
    const session = createGuestSession();
    const batch = createGuestBatch(session, {
      name: 'big',
      originalFile: 'x.csv',
      options: DEFAULT_RENDER_OPTIONS,
      products: products(GUEST_MAX_PRODUCTS_PER_BATCH),
    });
    expect(batch.products).toHaveLength(100);
  });
});

describe('memory budget', () => {
  it('reports nothing held by a session with no images', () => {
    resetGuestStore();
    const session = createGuestSession();
    createGuestBatch(session, {
      name: 'b',
      originalFile: 'x.csv',
      options: DEFAULT_RENDER_OPTIONS,
      products: products(10),
    });
    expect(guestBytesInUse()).toBe(0);
  });

  it('counts what guests are actually holding, not how many there are', () => {
    // The count ceiling stopped meaning anything when a session went from
    // twenty-five images to a hundred. Bytes are what gets a container killed.
    resetGuestStore();
    const session = createGuestSession();
    const batch = createGuestBatch(session, {
      name: 'b',
      originalFile: 'x.csv',
      options: DEFAULT_RENDER_OPTIONS,
      products: products(2),
    });
    batch.products[0]!.image = {
      id: 'img_1',
      kind: 'REAL',
      fileName: 'a.jpg',
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
      bytes: 1024,
      provider: null,
      sourceUrl: null,
      matchScore: 0,
      qualityScore: 0,
      buffer: Buffer.alloc(1024),
    };

    expect(guestBytesInUse()).toBe(1024);
    // And the session survives, because one image is nowhere near the ceiling.
    expect(guestSessionCount()).toBe(1);
  });
});

describe('confirming an uncertain result', () => {
  function sessionWithReview() {
    resetGuestStore();
    const session = createGuestSession();
    const batch = createGuestBatch(session, {
      name: 'b',
      originalFile: 'x.csv',
      options: DEFAULT_RENDER_OPTIONS,
      products: products(1),
    });
    const product = batch.products[0]!;
    product.status = 'NEEDS_REVIEW';
    product.reviewReason = 'Only a low-quality image could be found.';
    return { session, batch, product };
  }

  it('finds a product in its own session and nobody else\'s', () => {
    const { session, product } = sessionWithReview();
    const stranger = createGuestSession();

    expect(findGuestProduct(session, product.id)?.product.id).toBe(product.id);
    expect(findGuestProduct(stranger, product.id)).toBeNull();
  });

  it('does not call a batch finished while a row is still being retried', () => {
    // Rows going back through the ladder are PROCESSING, and a batch that
    // reported itself complete mid-ladder would show failures about to be
    // revisited as final.
    resetGuestStore();
    const session = createGuestSession();
    const batch = createGuestBatch(session, {
      name: 'b',
      originalFile: 'x.csv',
      options: DEFAULT_RENDER_OPTIONS,
      products: products(2),
    });
    batch.products[0]!.status = 'SUCCEEDED';
    batch.products[1]!.status = 'PROCESSING';

    settleGuestBatch(batch);
    expect(batch.status).toBe('PROCESSING');
    expect(batch.completedAt).toBeNull();
  });

  it('treats a reviewed row as a finished one', () => {
    const { batch, product } = sessionWithReview();
    void product;
    settleGuestBatch(batch);
    expect(batch.status).toBe('COMPLETED');
  });
});

describe('the export a review row lands in', () => {
  /** A row with an image, in whichever state the batch left it. */
  function row(outcome: 'ok' | 'needs_review' | 'failed', rowNumber = 1): ZipRow {
    return {
      rowNumber,
      sku: null,
      upc: '036000291452',
      name: `Product ${rowNumber}`,
      brand: null,
      model: null,
      category: null,
      description: null,
      price: null,
      facts: null,
      outcome,
      errorMessage: outcome === 'failed' ? 'Nothing found' : null,
      image:
        outcome === 'failed'
          ? null
          : {
              id: `img_${rowNumber}`,
              kind: ImageSourceKind.REAL,
              fileName: `product_${rowNumber}.jpg`,
              width: 1000,
              height: 1000,
              provider: 'openfoodfacts',
              sourceUrl: 'https://images.openfoodfacts.org/a.jpg',
              matchScore: 0.7,
              qualityScore: 0.4,
              read: async () => Buffer.from('jpeg-bytes'),
            },
    };
  }

  async function names(rows: ZipRow[]) {
    const { buffer, imageCount } = await buildZip({
      batchName: 'batch',
      createdAt: new Date('2026-08-26T00:00:00Z'),
      rows,
    });
    const entries = await unzip(buffer);
    return { entries, imageCount };
  }

  it('ships the picture of a row that is still awaiting a decision', async () => {
    // The whole point of the review status is that an image was found. Dropping
    // it from the download would make the flag worse than useless: the customer
    // is asked about a picture that is not in what they paid for.
    const { entries, imageCount } = await names([row('needs_review')]);
    expect(imageCount).toBe(1);
    expect(Object.keys(entries).some((name) => name.endsWith('product_1.jpg'))).toBe(true);
  });

  it('marks it in the CSV rather than passing it off as checked', async () => {
    const { entries } = await names([row('needs_review')]);
    const csv = entries['products_with_images.csv']!;
    expect(csv).toContain('check this one');
    expect(csv).toContain('Product Images/product_1.jpg');
  });

  it('does not list it as a failure', async () => {
    const { entries } = await names([row('needs_review')]);
    expect(entries['failed_products.csv']).toBeUndefined();
  });

  it('still leaves a genuinely empty row out', async () => {
    const { entries, imageCount } = await names([row('failed')]);
    expect(imageCount).toBe(0);
    expect(entries['failed_products.csv']).toContain('Nothing found');
  });

  it('counts a reviewed row among the images in the report', async () => {
    const { entries } = await names([row('ok', 1), row('needs_review', 2), row('failed', 3)]);
    const report = entries['processing_report.txt']!;
    expect(report).toContain('Images produced:          2');
    expect(report).toContain('Products without images:  1');
    expect(report).toContain('Worth a look:             1');
  });
});

/**
 * Read a ZIP without adding a dependency for one assertion.
 *
 * Walks the central directory rather than the local headers, because archiver
 * streams and puts the real sizes in a trailing data descriptor — the local
 * header's sizes are zero and parsing them yields empty files that quietly
 * satisfy any test asking only whether an entry exists.
 */
async function unzip(buffer: Buffer): Promise<Record<string, string>> {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: Record<string, string> = {};

  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    // The local header repeats the name and extra fields at its own lengths.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    entries[name] = (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

describe('the ladder itself', () => {
  /**
   * The two ways an automatic retry goes wrong are opposite and both silent: it
   * never stops (the same request on a metered key, forever), or it "retries"
   * without changing anything (three identical calls, three identical answers,
   * and a bill).
   */

  it('escalates rather than repeating itself', () => {
    const settings = EFFORT_LADDER.map((effort) => EFFORT[effort]);

    // Each rung has to differ from the one before it in something that could
    // plausibly change the answer.
    for (let i = 1; i < settings.length; i += 1) {
      const previous = settings[i - 1]!;
      const current = settings[i]!;
      const changed =
        current.maxDownloads !== previous.maxDownloads ||
        current.candidateLimit !== previous.candidateLimit ||
        current.forceWeb !== previous.forceWeb ||
        current.minQuality !== previous.minQuality ||
        current.acceptMarginal !== previous.acceptMarginal;
      expect(changed).toBe(true);
    }
  });

  it('never narrows the search on a later pass', () => {
    for (let i = 1; i < EFFORT_LADDER.length; i += 1) {
      const previous = EFFORT[EFFORT_LADDER[i - 1]!];
      const current = EFFORT[EFFORT_LADDER[i]!];
      expect(current.maxDownloads).toBeGreaterThanOrEqual(previous.maxDownloads);
      expect(current.candidateLimit).toBeGreaterThanOrEqual(previous.candidateLimit);
      expect(current.minQuality).toBeLessThanOrEqual(previous.minQuality);
    }
  });

  it('only the last rung will settle for a marginal image', () => {
    // If an earlier rung accepted marginal results, the later ones would never
    // run and the flag would be attached to answers that had more to try.
    const marginal = EFFORT_LADDER.filter((effort) => EFFORT[effort].acceptMarginal);
    expect(marginal).toEqual([EFFORT_LADDER[EFFORT_LADDER.length - 1]]);
  });

  it('terminates', () => {
    expect(EFFORT_LADDER.length).toBeGreaterThan(1);
    expect(EFFORT_LADDER.length).toBeLessThanOrEqual(4);
    expect(new Set(EFFORT_LADDER).size).toBe(EFFORT_LADDER.length);
  });

  it('picks a different setting for each attempt, then stops escalating', () => {
    // Drives the account path, where the rung comes from the attempt counter
    // rather than a loop. Clamping matters: a manual retry of an exhausted row
    // must run at the most forgiving setting, not crash on an index.
    expect(effortForAttempt(1)).toBe('normal');
    expect(effortForAttempt(2)).toBe('wider');
    expect(effortForAttempt(3)).toBe('lenient');
    expect(effortForAttempt(9)).toBe('lenient');
    // And an attempt counter that somehow arrives as zero still runs something.
    expect(effortForAttempt(0)).toBe('normal');
  });
});
