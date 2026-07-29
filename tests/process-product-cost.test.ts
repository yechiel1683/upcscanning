import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER_OPTIONS, type ProductFacts, type SearchCandidate } from '@/lib/types';

/**
 * What one barcode costs.
 *
 * The images are identical whether these hold or not, so nothing downstream
 * will ever complain — but a barcode that resolves from a product database
 * should not be paying for a language model it does not need, and a product
 * should not be rendering five images to keep one. Both were happening, and
 * both are the difference between a second and half a minute.
 */

const enrichProduct = vi.fn();
const renderProductImage = vi.fn();
const analyseImage = vi.fn();
const lookupBarcodeCached = vi.fn();
const searchWeb = vi.fn();
const fetchBinary = vi.fn();

vi.mock('@/server/providers/llm/enrichment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/providers/llm/enrichment')>();
  return { ...actual, enrichProduct };
});

vi.mock('@/server/images/render', () => ({
  renderProductImage,
  analyseImage,
  mimeTypeFor: () => 'image/jpeg',
}));

vi.mock('@/server/providers/search', () => ({ lookupBarcodeCached, searchWeb }));
vi.mock('@/server/lib/http', () => ({ fetchBinary }));
vi.mock('@/server/providers/generate', () => ({ generationProvider: () => null }));
vi.mock('@/server/providers/bgremove', () => ({
  backgroundRemovalMode: () => 'none',
  removeBackgroundHosted: vi.fn(),
}));

const { processProduct } = await import('@/server/pipeline/process-product');

function candidate(name: string, confidence = 0.95): SearchCandidate {
  return {
    provider: name,
    sourceUrl: `https://images.test/${name}.jpg`,
    providerConfidence: confidence,
    title: 'Duracell Coppertop AA Batteries 8 Pack',
  } as SearchCandidate;
}

const facts: ProductFacts = {
  source: 'upcitemdb',
  title: 'Duracell Coppertop AA Batteries 8 Pack',
  brand: 'Duracell',
} as ProductFacts;

/** A good photo, so scoring accepts every candidate and cannot short-circuit. */
const goodAnalysis = {
  width: 1500,
  height: 1500,
  hasAlpha: false,
  borderVariance: 20,
  foregroundRatio: 0.4,
  maskConfidence: 0.9,
  detail: 30,
  overlayShare: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Big enough to clear the "blank or over-compressed" gate, which judges bytes
  // against the pixel count analyseImage reports.
  const jpeg = Buffer.alloc(400_000, 0x7f);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
  fetchBinary.mockResolvedValue({ buffer: jpeg, contentType: 'image/jpeg' });
  analyseImage.mockResolvedValue(goodAnalysis);
  renderProductImage.mockResolvedValue({
    buffer: Buffer.from([1]),
    width: 1600,
    height: 1600,
    bytes: 1,
    mimeType: 'image/jpeg',
    metrics: {},
  });
  searchWeb.mockResolvedValue({ candidates: [], errors: [], facts: undefined });
  enrichProduct.mockResolvedValue({
    canonicalTitle: 'Duracell Coppertop AA Batteries 8 Pack',
    brand: 'Duracell',
    model: null,
    requiredKeywords: ['duracell'],
    negativeKeywords: [],
    searchQueries: ['duracell coppertop aa'],
    generationPrompt: 'a pack of batteries',
    source: 'openai',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const input = {
  product: { id: 'p1', rowNumber: 1, name: 'Product 036000291452', upc: '036000291452' },
  options: DEFAULT_RENDER_OPTIONS,
};

describe('cost of a barcode that a product database knows', () => {
  it('renders once, however many candidates it weighed', async () => {
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
      facts,
      errors: [],
      providers: ['upcitemdb'],
    });

    const outcome = await processProduct(input);

    expect(outcome.status).toBe('succeeded');
    expect(renderProductImage).toHaveBeenCalledTimes(1);
  });

  it('does not call a language model it does not need', async () => {
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('a')],
      facts,
      errors: [],
      providers: ['upcitemdb'],
    });

    const outcome = await processProduct(input);

    expect(outcome.status).toBe('succeeded');
    expect(enrichProduct).not.toHaveBeenCalled();
    // And it never reached the web tier either.
    expect(searchWeb).not.toHaveBeenCalled();
  });
});

describe('cost of a barcode nothing recognises', () => {
  it('does call the model, because the web query is what it is for', async () => {
    lookupBarcodeCached.mockResolvedValue({
      candidates: [],
      facts: undefined,
      errors: [],
      providers: [],
    });
    searchWeb.mockResolvedValue({ candidates: [candidate('web')], errors: [], facts: undefined });

    const outcome = await processProduct(input);

    expect(enrichProduct).toHaveBeenCalledTimes(1);
    expect(searchWeb).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('succeeded');
  });

  it('still renders only once after searching both tiers', async () => {
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('barcode', 0.5)],
      facts: undefined,
      errors: [],
      providers: [],
    });
    searchWeb.mockResolvedValue({
      candidates: [candidate('web1'), candidate('web2')],
      errors: [],
      facts: undefined,
    });

    await processProduct(input);
    expect(renderProductImage).toHaveBeenCalledTimes(1);
  });
});

describe('when the one render fails', () => {
  it('reports the product as failed rather than throwing', async () => {
    // Deferring the render moves its failures after the search has committed,
    // so the path has to be handled rather than assumed away.
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('a')],
      facts,
      errors: [],
      providers: ['upcitemdb'],
    });
    renderProductImage.mockRejectedValue(new Error('corrupt JPEG'));

    const outcome = await processProduct(input);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.reason).toBeTruthy();
    expect(outcome.candidates.some((c) => c.rejectedReason?.includes('corrupt JPEG'))).toBe(true);
  });
});
