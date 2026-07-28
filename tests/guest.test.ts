import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER_OPTIONS, type ParsedProduct } from '@/lib/types';
import {
  createGuestBatch,
  createGuestSession,
  findGuestBatch,
  findGuestImage,
  getGuestSession,
  guestSessionCount,
  newImageId,
  resetGuestStore,
  settleGuestBatch,
  GUEST_MAX_BATCHES,
} from '@/server/guest/store';

/**
 * Guest sessions live in this process's memory on a route anyone can reach, so
 * the properties that matter are the ones that stop that being a liability:
 * they expire, they are capped, and one guest can never read another's images.
 */

function products(n: number): ParsedProduct[] {
  return Array.from({ length: n }, (_, i) => ({
    rowNumber: i + 1,
    upc: `03600029145${i}`,
    name: `Product ${i}`,
    extra: {},
  }));
}

function makeBatch(session: ReturnType<typeof createGuestSession>, name = 'batch') {
  return createGuestBatch(session, {
    name,
    originalFile: 'x.csv',
    options: DEFAULT_RENDER_OPTIONS,
    products: products(2),
  });
}

afterEach(() => {
  vi.useRealTimers();
  resetGuestStore();
});

describe('guest sessions', () => {
  it('issues a session with credits and no account', () => {
    const session = createGuestSession();
    expect(session.credits).toBeGreaterThan(0);
    expect(session.batches).toEqual([]);
    expect(getGuestSession(session.id)?.id).toBe(session.id);
  });

  it('does not resolve an unknown or missing id', () => {
    expect(getGuestSession('nope')).toBeNull();
    expect(getGuestSession(undefined)).toBeNull();
  });

  it('expires, so abandoned sessions cannot accumulate', () => {
    vi.useFakeTimers();
    const session = createGuestSession();

    vi.advanceTimersByTime(4 * 60 * 60 * 1000);
    expect(getGuestSession(session.id)).toBeNull();
    expect(guestSessionCount()).toBe(0);
  });

  it('extends expiry while a guest is active, so a batch cannot expire mid-run', () => {
    vi.useFakeTimers();
    const session = createGuestSession();

    // Two hours in, still touching it.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(getGuestSession(session.id)).not.toBeNull();

    // Two more hours: without the touch this would be past the three-hour TTL.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(getGuestSession(session.id)).not.toBeNull();
  });

  it('caps stored batches so image buffers cannot pile up', () => {
    const session = createGuestSession();
    for (let i = 0; i < GUEST_MAX_BATCHES + 4; i += 1) makeBatch(session, `batch ${i}`);

    expect(session.batches).toHaveLength(GUEST_MAX_BATCHES);
    // Newest kept, oldest dropped.
    expect(session.batches[0]?.name).toBe(`batch ${GUEST_MAX_BATCHES + 3}`);
  });
});

describe('guest isolation', () => {
  it('never resolves another session\'s batch', () => {
    const mine = createGuestSession();
    const theirs = createGuestSession();
    const batch = makeBatch(mine);

    expect(findGuestBatch(mine, batch.id)?.id).toBe(batch.id);
    expect(findGuestBatch(theirs, batch.id)).toBeNull();
  });

  it('never resolves another session\'s image', () => {
    const mine = createGuestSession();
    const theirs = createGuestSession();
    const batch = makeBatch(mine);

    const imageId = newImageId();
    batch.products[0]!.image = {
      id: imageId,
      kind: 'REAL',
      fileName: 'a.jpg',
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
      bytes: 1,
      provider: null,
      sourceUrl: null,
      matchScore: 0,
      qualityScore: 0,
      buffer: Buffer.from([1]),
    };

    expect(findGuestImage(mine, imageId)?.id).toBe(imageId);
    expect(findGuestImage(theirs, imageId)).toBeNull();
  });
});

describe('settleGuestBatch', () => {
  it('stays processing while any product is unfinished', () => {
    const session = createGuestSession();
    const batch = makeBatch(session);
    batch.products[0]!.status = 'SUCCEEDED';

    settleGuestBatch(batch);
    expect(batch.status).toBe('PROCESSING');
    expect(batch.completedAt).toBeNull();
  });

  it('completes cleanly when everything succeeded', () => {
    const session = createGuestSession();
    const batch = makeBatch(session);
    for (const product of batch.products) product.status = 'SUCCEEDED';

    settleGuestBatch(batch);
    expect(batch.status).toBe('COMPLETED');
    expect(batch.completedAt).not.toBeNull();
  });

  it('flags a batch that had failures', () => {
    const session = createGuestSession();
    const batch = makeBatch(session);
    batch.products[0]!.status = 'SUCCEEDED';
    batch.products[1]!.status = 'FAILED';

    settleGuestBatch(batch);
    expect(batch.status).toBe('COMPLETED_WITH_ERRORS');
  });
});
