import { describe, expect, it } from 'vitest';

import type { ProductEnrichment, SearchCandidate } from '@/lib/types';
import { heuristicEnrichment } from '@/server/providers/llm/enrichment';
import { scoreMatch, scoreQuality } from '@/server/images/quality';

function enrichment(overrides: Partial<ProductEnrichment> = {}): ProductEnrichment {
  return {
    canonicalTitle: 'DeWalt DCD771C2 20V Max Cordless Drill',
    brand: 'DeWalt',
    model: 'DCD771C2',
    searchQueries: ['DeWalt DCD771C2'],
    generationPrompt: 'prompt',
    negativeKeywords: ['case', 'battery', 'charger', 'replacement'],
    requiredKeywords: ['dewalt', 'dcd771c2'],
    source: 'heuristic',
    ...overrides,
  };
}

function candidate(overrides: Partial<SearchCandidate> = {}): SearchCandidate {
  return {
    provider: 'serpapi',
    sourceUrl: 'https://images.example.com/dewalt-dcd771c2.jpg',
    title: 'DeWalt DCD771C2 20V Max Cordless Drill Driver',
    width: 1200,
    height: 1200,
    providerConfidence: 0.65,
    ...overrides,
  };
}

describe('heuristicEnrichment', () => {
  it('pulls the brand from the first token when no brand column exists', () => {
    const result = heuristicEnrichment({ name: 'Samsung 55 Inch Smart TV' });
    expect(result.brand).toBe('Samsung');
  });

  it('recognises a model number inside the product name', () => {
    const result = heuristicEnrichment({ name: 'Sony WF-1000XM5 Earbuds' });
    expect(result.model).toBe('WF-1000XM5');
  });

  it('does not mistake a measurement for a model number', () => {
    const result = heuristicEnrichment({ name: 'Cable 6ft Braided' });
    expect(result.model).toBeUndefined();
  });

  it('puts the barcode first in the search queries', () => {
    const result = heuristicEnrichment({ name: 'Widget', upc: '036000291452' });
    expect(result.searchQueries[0]).toBe('036000291452');
  });

  it('does not treat a word from the product name as a negative keyword', () => {
    // A phone case really is a case; "case" must not disqualify its own photos.
    const result = heuristicEnrichment({ name: 'OtterBox iPhone 15 Case' });
    expect(result.negativeKeywords).not.toContain('case');
  });

  it('builds a generation prompt that specifies catalog styling', () => {
    const result = heuristicEnrichment({ name: 'Widget', brand: 'Acme' });
    expect(result.generationPrompt).toMatch(/white/i);
    expect(result.generationPrompt).toMatch(/no people/i);
  });
});

describe('scoreMatch', () => {
  it('scores a clean brand-and-model match highly', () => {
    const result = scoreMatch({ candidate: candidate(), enrichment: enrichment() });
    expect(result.rejected).toBe(false);
    expect(result.score).toBeGreaterThan(0.6);
  });

  it('rejects an accessory listing', () => {
    const result = scoreMatch({
      candidate: candidate({ title: 'Replacement Battery for DeWalt DCD771C2 Drill' }),
      enrichment: enrichment(),
    });
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/accessory/i);
  });

  it('rejects thumbnails and icons by URL shape', () => {
    expect(
      scoreMatch({
        candidate: candidate({ sourceUrl: 'https://cdn.example.com/thumb/x.jpg', width: undefined, height: undefined }),
        enrichment: enrichment(),
      }).rejected,
    ).toBe(true);

    expect(
      scoreMatch({
        candidate: candidate({ sourceUrl: 'https://cdn.example.com/logo.png', width: undefined, height: undefined }),
        enrichment: enrichment(),
      }).rejected,
    ).toBe(true);
  });

  it('rejects images that are too small to become a catalog image', () => {
    const result = scoreMatch({
      candidate: candidate({ width: 150, height: 150 }),
      enrichment: enrichment(),
    });
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/too small/i);
  });

  it('rejects banner-shaped images', () => {
    const result = scoreMatch({
      candidate: candidate({ width: 1600, height: 300 }),
      enrichment: enrichment(),
    });
    expect(result.rejected).toBe(true);
  });

  it('rejects a web result with no brand or model anywhere in it', () => {
    const result = scoreMatch({
      candidate: candidate({ title: 'Generic Power Tool Photo', sourceUrl: 'https://x.com/a.jpg' }),
      enrichment: enrichment(),
    });
    expect(result.rejected).toBe(true);
  });

  it('boosts a candidate whose page carries the barcode', () => {
    const withUpc = scoreMatch({
      candidate: candidate({ pageUrl: 'https://shop.example.com/p/885911574518' }),
      enrichment: enrichment(),
      upc: '885911574518',
    });
    const without = scoreMatch({ candidate: candidate(), enrichment: enrichment() });
    expect(withUpc.score).toBeGreaterThan(without.score);
  });

  it('trusts a barcode-database hit even if the title mentions an accessory', () => {
    // A GTIN lookup is exact; a stray word in the vendor title should not veto it.
    const result = scoreMatch({
      candidate: candidate({
        provider: 'upcitemdb',
        providerConfidence: 0.95,
        title: 'DeWalt DCD771C2 Drill with Battery and Charger',
      }),
      enrichment: enrichment(),
    });
    expect(result.rejected).toBe(false);
  });
});

describe('scoreQuality', () => {
  it('rewards a large, square, clean-background photo', () => {
    const result = scoreQuality({
      width: 2000,
      height: 2000,
      bytes: 900_000,
      borderVariance: 40,
      foregroundRatio: 0.4,
      detail: 30,
    });
    expect(result.rejected).toBe(false);
    expect(result.score).toBeGreaterThan(0.8);
    expect(result.notes).toContain('clean background');
  });

  it('rejects tiny images', () => {
    const result = scoreQuality({ width: 200, height: 200, bytes: 8000 });
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/resolution/i);
  });

  it('rejects an image whose byte count implies it is blank', () => {
    const result = scoreQuality({ width: 2000, height: 2000, bytes: 1200 });
    expect(result.rejected).toBe(true);
    expect(result.reason).toMatch(/blank|compressed/i);
  });

  it('scores a busy-background photo below a clean one', () => {
    const clean = scoreQuality({ width: 1200, height: 1200, bytes: 400_000, borderVariance: 50, foregroundRatio: 0.4 });
    const busy = scoreQuality({ width: 1200, height: 1200, bytes: 400_000, borderVariance: 2500, foregroundRatio: 0.4 });
    expect(busy.score).toBeLessThan(clean.score);
    expect(busy.notes).toContain('busy background');
  });
});
