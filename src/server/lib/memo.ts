/**
 * A bounded, expiring, in-process cache.
 *
 * The barcode cache lives in Postgres, which is correct for a fleet — it is
 * shared, it survives restarts, and it is what makes a free provider tier
 * usable across a whole instance. It also does not exist in guest mode, where
 * there is no database at all, so every lookup went out live every time. The
 * same barcode typed twice cost two round trips and two of a hundred daily
 * lookups, and the second one was no faster than the first.
 *
 * This sits in front of that. It is per-process and vanishes on restart, which
 * is exactly the trade a cache in front of a slower cache should make: it never
 * has to be right about anything the durable one is authoritative for, only
 * quick about the thing somebody just asked for.
 *
 * Bounded by entry count rather than bytes, so callers holding image buffers
 * must choose a small limit and know roughly what one entry weighs.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface MemoOptions {
  /** How long an entry stays usable. */
  ttlMs: number;
  /** How many entries to keep before evicting the least recently used. */
  max: number;
}

export class Memo<T> {
  // Map preserves insertion order, which is all that is needed to evict the
  // oldest: re-inserting on read moves an entry to the end.
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly options: MemoOptions) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Touch, so the busiest keys are the last to be evicted.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.options.ttlMs });
    while (this.entries.size > this.options.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
