import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER_OPTIONS, type SearchCandidate } from '@/lib/types';
import { chooseWorkingEdge } from '@/server/images/render';
import { lookupBarcodeWith } from '@/server/providers/search';
import type { SearchProvider } from '@/server/providers/search/types';

/**
 * Speed here is not a nice-to-have — it is what someone typing one barcode
 * experiences as the product working or not. Each of these guards a specific
 * piece of work that used to happen and did not need to, and every one of them
 * is invisible in the output: the images come out identical either way, so
 * nothing but a test will notice them creeping back.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeProvider(name: string, delayMs: number): SearchProvider {
  return {
    name,
    tier: 'barcode',
    keyless: true,
    configured: () => true,
    supports: () => true,
    search: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        candidates: [
          {
            provider: name,
            sourceUrl: `https://example.test/${name}.jpg`,
            providerConfidence: 0.9,
          } as SearchCandidate,
        ],
        facts: { source: name, title: `From ${name}` },
      };
    },
  } as unknown as SearchProvider;
}

const context = {
  upc: '036000291452',
  name: 'Product 036000291452',
  enrichment: {
    canonicalTitle: 'Product',
    requiredKeywords: [],
    negativeKeywords: [],
    searchQueries: [],
    generationPrompt: '',
    source: 'heuristic',
  },
  limit: 12,
} as never;

describe('barcode tier fan-out', () => {
  it('asks every database at once rather than one after another', async () => {
    // Five databases, each keyed on the same number, none able to inform
    // another. In sequence this is 250ms; concurrently it is one round trip.
    const providers = [50, 50, 50, 50, 50].map((ms, i) => fakeProvider(`db${i}`, ms));

    const started = Date.now();
    const result = await lookupBarcodeWith(providers, context);
    const elapsed = Date.now() - started;

    expect(result.candidates).toHaveLength(5);
    // Comfortably under the 250ms a sequential walk would cost, with enough
    // headroom that a slow machine does not make this flaky.
    expect(elapsed).toBeLessThan(160);
  });

  it('merges in provider order, not in the order the network answered', async () => {
    // Otherwise the same barcode resolves differently run to run, purely on
    // which host happened to be quick.
    const providers = [fakeProvider('slow', 60), fakeProvider('fast', 1)];

    const result = await lookupBarcodeWith(providers, context);
    expect(result.candidates.map((candidate) => candidate.provider)).toEqual(['slow', 'fast']);
    expect(result.facts?.title).toBe('From slow');
  });

  it('lets one database fail without taking the tier down with it', async () => {
    const broken: SearchProvider = {
      ...fakeProvider('broken', 1),
      search: async () => {
        throw new Error('502 from upstream');
      },
    } as SearchProvider;

    const result = await lookupBarcodeWith([broken, fakeProvider('working', 1)], context);

    expect(result.candidates).toHaveLength(1);
    expect(result.errors[0]?.provider).toBe('broken');
  });
});

describe('chooseWorkingEdge', () => {
  const mask = (fraction: number) =>
    ({
      width: 640,
      height: 640,
      bounds: { left: 0, top: 0, width: 640 * fraction, height: 640 * fraction },
    }) as never;

  it('asks for more source when the subject is small in frame', () => {
    // A product filling a fifth of the frame needs five times the pixels to
    // land at the same output size once the rest is cropped away.
    expect(chooseWorkingEdge(1400, mask(0.2))).toBeGreaterThan(chooseWorkingEdge(1400, mask(0.8)));
  });

  it('never asks for less than the output needs', () => {
    expect(chooseWorkingEdge(1400, mask(1))).toBeGreaterThanOrEqual(1400);
  });

  it('caps a tiny subject rather than decoding an enormous frame for it', () => {
    // Without a ceiling, a stamp in the corner of a photo asks for a source
    // edge in the tens of thousands of pixels — which is how a container dies.
    expect(chooseWorkingEdge(1400, mask(0.02))).toBeLessThanOrEqual(2800);
  });

  it('falls back to a bounded guess when there is no mask', () => {
    const edge = chooseWorkingEdge(1400, null);
    expect(edge).toBeGreaterThanOrEqual(1400);
    expect(edge).toBeLessThanOrEqual(2800);
  });
});

describe('render options', () => {
  it('keeps the default output at a size a container can hold', () => {
    // 1600x1600 RGBA is ~10MB per frame in flight; the working copy is capped
    // at twice the inner edge on top of that. Raising this silently multiplies
    // the peak of every concurrent job.
    expect(DEFAULT_RENDER_OPTIONS.width).toBeLessThanOrEqual(2000);
    expect(DEFAULT_RENDER_OPTIONS.height).toBeLessThanOrEqual(2000);
  });
});
