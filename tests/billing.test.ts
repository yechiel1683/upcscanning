import { describe, expect, it } from 'vitest';

import { PACKS, centsPerImage, findPack, formatPrice } from '@/lib/packs';

/**
 * The parts of billing that can be checked without a database or a network.
 *
 * The crediting logic itself is exercised against a real PostgreSQL in
 * `scripts/verify-billing.ts`, because the property that matters most — that a
 * redelivered webhook cannot credit twice — is enforced by a unique constraint
 * rather than by application code, and a mock would happily let it through.
 */

describe('the packs on sale', () => {
  it('has no duplicate ids, which would make a purchase ambiguous', () => {
    expect(new Set(PACKS.map((pack) => pack.id)).size).toBe(PACKS.length);
  });

  it('prices every pack in whole cents', () => {
    // A fractional cent means somewhere a float got into the money path.
    for (const pack of PACKS) {
      expect(Number.isInteger(pack.amount)).toBe(true);
      expect(pack.amount).toBeGreaterThan(0);
    }
  });

  it('gets cheaper per image as the pack gets bigger', () => {
    // If a bigger pack ever costs more per image, somebody buying in bulk is
    // penalised for it, and they will notice before we do.
    const sorted = [...PACKS].sort((a, b) => a.credits - b.credits);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(centsPerImage(sorted[i]!)).toBeLessThan(centsPerImage(sorted[i - 1]!));
    }
  });

  it('grants a whole number of images', () => {
    for (const pack of PACKS) {
      expect(Number.isInteger(pack.credits)).toBe(true);
      expect(pack.credits).toBeGreaterThan(0);
    }
  });

  it('finds a pack by id and refuses anything else', () => {
    // The checkout route looks packs up by an id the client sent, so this is
    // the boundary that stops somebody inventing a pack.
    expect(findPack('standard-1000')?.credits).toBe(1000);
    expect(findPack('free-1000000')).toBeNull();
    expect(findPack('')).toBeNull();
    expect(findPack('__proto__')).toBeNull();
  });

  it('formats prices the way a person writes them', () => {
    expect(formatPrice(2900)).toBe('$29');
    expect(formatPrice(9900)).toBe('$99');
    // Not $29.00 — trailing zeroes on a round number read as noise.
    expect(formatPrice(3550)).toBe('$35.50');
  });
});
