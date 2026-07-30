import { afterEach, describe, expect, it, vi } from 'vitest';

import { Memo } from '@/server/lib/memo';

/**
 * A cache that never forgets is a memory leak, and one that forgets the wrong
 * entry is a cache that does nothing. Both failures are silent — the product
 * keeps working, just slower or fatter — so they are only ever caught here.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('Memo', () => {
  it('returns what it was given', () => {
    const memo = new Memo<string>({ ttlMs: 1000, max: 10 });
    memo.set('a', 'hello');
    expect(memo.get('a')).toBe('hello');
  });

  it('reports nothing for a key it has never seen', () => {
    expect(new Memo<string>({ ttlMs: 1000, max: 10 }).get('missing')).toBeUndefined();
  });

  it('forgets an entry once it has expired', () => {
    vi.useFakeTimers();
    const memo = new Memo<string>({ ttlMs: 1000, max: 10 });
    memo.set('a', 'hello');

    vi.advanceTimersByTime(999);
    expect(memo.get('a')).toBe('hello');

    vi.advanceTimersByTime(2);
    expect(memo.get('a')).toBeUndefined();
    // And it is dropped rather than left to accumulate.
    expect(memo.size).toBe(0);
  });

  it('evicts the oldest entry rather than growing without limit', () => {
    const memo = new Memo<number>({ ttlMs: 60_000, max: 3 });
    memo.set('a', 1);
    memo.set('b', 2);
    memo.set('c', 3);
    memo.set('d', 4);

    expect(memo.size).toBe(3);
    expect(memo.get('a')).toBeUndefined();
    expect(memo.get('d')).toBe(4);
  });

  it('keeps the entries actually being used', () => {
    // Eviction by insertion order alone would throw away the one key everybody
    // asks for, purely because it was asked for first.
    const memo = new Memo<number>({ ttlMs: 60_000, max: 3 });
    memo.set('popular', 1);
    memo.set('b', 2);
    memo.set('c', 3);

    memo.get('popular');
    memo.set('d', 4);

    expect(memo.get('popular')).toBe(1);
    expect(memo.get('b')).toBeUndefined();
  });

  it('replaces a value without growing', () => {
    const memo = new Memo<number>({ ttlMs: 60_000, max: 3 });
    memo.set('a', 1);
    memo.set('a', 2);
    expect(memo.size).toBe(1);
    expect(memo.get('a')).toBe(2);
  });

  it('refreshes the expiry when a value is replaced', () => {
    vi.useFakeTimers();
    const memo = new Memo<number>({ ttlMs: 1000, max: 3 });
    memo.set('a', 1);

    vi.advanceTimersByTime(900);
    memo.set('a', 2);

    vi.advanceTimersByTime(900);
    expect(memo.get('a')).toBe(2);
  });
});
