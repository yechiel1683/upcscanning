import { describe, expect, it } from 'vitest';

import { productJobId } from '@/server/queue';

/**
 * The retry ladder queues a product's next pass from inside the job running its
 * current one. Deduplication used to be keyed on the product alone, which meant
 * that enqueue collided with the job doing the enqueueing and was dropped
 * silently — the row would sit at PENDING forever and the batch would never
 * finish. A hang is a worse outcome than the failure it was trying to avoid,
 * and it is invisible: no error, no log, just a batch that never completes.
 *
 * Same trap for a manual retry, which collides with the completed job still
 * sitting in the queue's retention window.
 */

describe('productJobId', () => {
  it('gives each pass of a product its own key', () => {
    const productId = 'p_1';
    const first = productJobId({ productId, attempt: 1 });
    const second = productJobId({ productId, attempt: 2 });
    const third = productJobId({ productId, attempt: 3 });

    expect(new Set([first, second, third]).size).toBe(3);
  });

  it('still collapses a genuine duplicate within one pass', () => {
    // Two workers reaching the same conclusion at once should queue one job,
    // not two, or the product is processed twice and billed twice.
    expect(productJobId({ productId: 'p_1', attempt: 2 })).toBe(
      productJobId({ productId: 'p_1', attempt: 2 }),
    );
  });

  it('keeps different products apart at the same attempt', () => {
    expect(productJobId({ productId: 'p_1', attempt: 2 })).not.toBe(
      productJobId({ productId: 'p_2', attempt: 2 }),
    );
  });

  it('leaves a first enqueue on the plain key', () => {
    // The initial upload has no attempt to state, and changing its key would
    // stop the existing deduplication working on the path that has always had
    // it: one upload, thousands of rows, one job each.
    expect(productJobId({ productId: 'p_1' })).toBe('product:p_1');
    expect(productJobId({ productId: 'p_1', attempt: 0 })).toBe('product:p_1');
  });
});
