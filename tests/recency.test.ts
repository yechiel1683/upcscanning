import { describe, expect, it } from 'vitest';

import { scoreRecency } from '@/server/images/recency';

/**
 * Packaging changes. A body wash on shelves for a decade has had several looks,
 * every one of them still online, and all of them pass an identity check —
 * so choosing between two genuine photographs of the right product is a
 * separate question with its own way of being wrong.
 *
 * Being wrong here is quiet. The catalog fills with real photographs of real
 * products in packaging nobody has seen for years, and nothing complains.
 */

const now = new Date('2026-07-30T00:00:00Z');

describe('scoreRecency', () => {
  it('trusts a recent Last-Modified above anything else', () => {
    const fresh = scoreRecency({
      sourceUrl: 'https://images.upcitemdb.com/whatever.jpg',
      lastModified: 'Mon, 01 Jun 2026 10:00:00 GMT',
      now,
    });
    // An archive host that says its picture is from this year is believed.
    expect(fresh.score).toBe(1);
  });

  it('marks down an image the host itself calls old', () => {
    const stale = scoreRecency({
      sourceUrl: 'https://cdn.walmart.com/asset.jpg',
      lastModified: 'Mon, 01 Jun 2014 10:00:00 GMT',
      now,
    });
    const recent = scoreRecency({
      sourceUrl: 'https://cdn.walmart.com/asset.jpg',
      lastModified: 'Mon, 01 Jun 2026 10:00:00 GMT',
      now,
    });
    expect(stale.score).toBeLessThan(recent.score);
  });

  it('ignores a Last-Modified that cannot be true', () => {
    // Some hosts stamp a future date, or 1970, or nonsense. None of those is a
    // reason to reorder anything.
    const future = scoreRecency({
      sourceUrl: 'https://example.com/a.jpg',
      lastModified: 'Mon, 01 Jun 2099 10:00:00 GMT',
      now,
    });
    const epoch = scoreRecency({
      sourceUrl: 'https://example.com/a.jpg',
      lastModified: 'Thu, 01 Jan 1970 00:00:00 GMT',
      now,
    });
    const garbage = scoreRecency({
      sourceUrl: 'https://example.com/a.jpg',
      lastModified: 'sometime last week',
      now,
    });
    for (const result of [future, epoch, garbage]) {
      expect(result.reason).toBe('no date signal');
    }
  });

  it('reads a year out of a CDN path', () => {
    const result = scoreRecency({
      sourceUrl: 'https://cdn.example.com/uploads/2026/03/dial-body-wash.jpg',
      now,
    });
    expect(result.score).toBe(1);
  });

  it('reads a cache-busting timestamp', () => {
    // Retail CDNs version their assets this way, and the version is when the
    // packaging changed.
    const seconds = Math.floor(Date.UTC(2026, 4, 1) / 1000);
    const result = scoreRecency({
      sourceUrl: `https://i5.example.com/asin/x.jpeg?v=${seconds}`,
      now,
    });
    expect(result.score).toBe(1);
  });

  it('does not mistake a product code for a year', () => {
    // Four digits in a URL are far more often a SKU, a size or a pixel
    // dimension. Reading those as dates would scramble the ranking on most of
    // the internet.
    const result = scoreRecency({
      sourceUrl: 'https://cdn.example.com/products/8420/1200x1200/bottle.jpg',
      now,
    });
    expect(result.reason).toBe('no date signal');
  });

  it('prefers a shop that sells it now over an archive that catalogued it once', () => {
    const retailer = scoreRecency({ sourceUrl: 'https://i5.walmartimages.com/x.jpeg', pageUrl: 'https://www.walmart.com/ip/1', now });
    const archive = scoreRecency({ sourceUrl: 'https://images.upcitemdb.com/x.jpg', now });
    expect(retailer.score).toBeGreaterThan(archive.score);
  });

  it('leaves an unknown host in the middle rather than punishing it', () => {
    // A manufacturer's own site is usually the best source there is, and it
    // will not be on any list. Silence must not be treated as staleness.
    const unknown = scoreRecency({ sourceUrl: 'https://www.dialsoap.com/img/wash.jpg', now });
    const archive = scoreRecency({ sourceUrl: 'https://images.upcitemdb.com/x.jpg', now });
    expect(unknown.score).toBeGreaterThan(archive.score);
    expect(unknown.score).toBeLessThan(1);
  });

  it('survives a URL that is not a URL', () => {
    expect(() => scoreRecency({ sourceUrl: 'not a url', now })).not.toThrow();
    expect(scoreRecency({ sourceUrl: 'not a url', now }).score).toBe(0.5);
  });

  it('matches a subdomain of a known host, not a lookalike', () => {
    expect(scoreRecency({ sourceUrl: 'https://m.media-amazon.com/images/I/x.jpg', now }).score).toBe(
      0.75,
    );
    // Someone else's domain that merely ends with the same letters is not them.
    expect(
      scoreRecency({ sourceUrl: 'https://notwalmart.com/x.jpg', now }).reason,
    ).toBe('no date signal');
  });
});
