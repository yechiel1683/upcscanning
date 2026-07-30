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

const generate = vi.fn();
const generationProvider = vi.fn(() => null as { name: string; generate: typeof generate } | null);
vi.mock("@/server/providers/generate", () => ({ generationProvider: () => generationProvider() }));

const verifyProductImage = vi.fn();
const verificationAvailable = vi.fn(() => false);
vi.mock('@/server/providers/llm/verify', () => ({
  verifyProductImage: (...args: unknown[]) => verifyProductImage(...args),
  verificationAvailable: () => verificationAvailable(),
}));
vi.mock('@/server/providers/bgremove', () => ({
  backgroundRemovalMode: () => 'none',
  removeBackgroundHosted: vi.fn(),
}));

const { processProduct, resetRenderMemo } = await import('@/server/pipeline/process-product');

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
  // Rendered images are cached by source URL across the process, so without
  // this a later test is served an earlier one's render and never exercises
  // the path it is about.
  resetRenderMemo();
  generationProvider.mockReturnValue(null);
  verificationAvailable.mockReturnValue(false);
  verifyProductImage.mockResolvedValue({ verdict: "unknown", shown: "", reason: "not configured" });
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

describe('running the same barcode again', () => {
  it('does not re-download, re-analyse or re-render the same photograph', async () => {
    // The case somebody is actually watching. Nothing about rendering an image
    // depends on anything but its URL and the output settings, so the second
    // run should be the cache and nothing else.
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('a')],
      facts,
      errors: [],
      providers: ['upcitemdb'],
    });

    const first = await processProduct(input);
    expect(first.status).toBe('succeeded');
    expect(renderProductImage).toHaveBeenCalledTimes(1);

    const second = await processProduct(input);
    expect(second.status).toBe('succeeded');
    expect(renderProductImage).toHaveBeenCalledTimes(1);
    expect(fetchBinary).toHaveBeenCalledTimes(1);
  });

  it('renders again when the output settings change', async () => {
    // Otherwise a different size or background would be served the old image.
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('a')],
      facts,
      errors: [],
      providers: ['upcitemdb'],
    });

    await processProduct(input);
    await processProduct({
      ...input,
      options: { ...DEFAULT_RENDER_OPTIONS, width: 800, height: 800 },
    });

    expect(renderProductImage).toHaveBeenCalledTimes(2);
  });
});

describe('weighing several candidates', () => {
  it('fetches them together rather than one after another', async () => {
    // Each is a download from a different host and none informs the next, so in
    // sequence the product waits for the sum of them.
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('a', 0.5), candidate('b', 0.5), candidate('c', 0.5)],
      facts,
      errors: [],
      providers: ['upcitemdb'],
    });

    let inFlight = 0;
    let peak = 0;
    fetchBinary.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      const jpeg = Buffer.alloc(400_000, 0x7f);
      jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
      return { buffer: jpeg, contentType: 'image/jpeg' };
    });

    await processProduct(input);
    expect(peak).toBeGreaterThan(1);
  });
});

/** Generation is opt-in now, so these have to ask for it. */
const generating = {
  ...input,
  options: { ...DEFAULT_RENDER_OPTIONS, allowAiGeneration: true },
};

describe('inventing an image is opt-in', () => {
  it('is off by default, because an invented image is not the product', async () => {
    // Three generic bottles — one with the barcode printed across it — went
    // into a catalog beside three real photographs, told apart only by a small
    // badge. An empty cell is the better of those two outcomes.
    lookupBarcodeCached.mockResolvedValue({
      candidates: [],
      facts: undefined,
      errors: [],
      providers: [],
    });
    generationProvider.mockReturnValue({ name: 'openai', generate });

    const outcome = await processProduct(input);

    expect(outcome.status).toBe('failed');
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('a generated image that shows the wrong product', () => {
  beforeEach(() => {
    // Nothing findable, so the run falls through to Workflow B.
    lookupBarcodeCached.mockResolvedValue({
      candidates: [],
      facts: undefined,
      errors: [],
      providers: [],
    });
    generationProvider.mockReturnValue({ name: 'openai', generate });
    generate.mockResolvedValue({
      buffer: Buffer.alloc(1000),
      provider: 'openai',
      model: 'gpt-image-1',
    });
  });

  it('is discarded rather than filed under the barcode', async () => {
    // The failure that started this: a body wash came back as a box of tea,
    // correctly named and correctly labelled "AI generated". A missing image is
    // a gap somebody fills; a confident wrong one gets sold from.
    verifyProductImage.mockResolvedValue({
      verdict: 'mismatch',
      shown: 'a box of Lipton black tea',
      reason: 'The image shows a box of Lipton black tea',
    });

    const outcome = await processProduct(generating);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).toContain('Lipton');
    }
    // And it never reached the renderer, so nothing was stored.
    expect(renderProductImage).not.toHaveBeenCalled();
  });

  it('is kept when the verifier confirms it', async () => {
    verifyProductImage.mockResolvedValue({ verdict: 'match', shown: 'body wash', reason: 'ok' });

    const outcome = await processProduct(generating);
    expect(outcome.status).toBe('succeeded');
    if (outcome.status === 'succeeded') expect(outcome.kind).toBe('AI_GENERATED');
  });

  it('is kept when the verifier cannot say, rather than failing every product', async () => {
    // An outage in the checker must not become an outage in the product.
    verifyProductImage.mockResolvedValue({ verdict: 'unknown', shown: '', reason: 'timeout' });

    const outcome = await processProduct(generating);
    expect(outcome.status).toBe('succeeded');
  });
});

describe('a real photo the text signals were unsure about', () => {
  it('is rejected when the verifier says it is a different product', async () => {
    verificationAvailable.mockReturnValue(true);
    verifyProductImage.mockResolvedValue({
      verdict: 'mismatch',
      shown: 'a garden hose',
      reason: 'The image shows a garden hose',
    });
    // Facts so the row resolves to a real name and the candidate clears the
    // keyword gate, but a middling provider confidence so the match score lands
    // between "worth downloading" and "certain" — which is the band the vision
    // check exists for.
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('weak', 0.6)],
      facts,
      errors: [],
      providers: ['upcitemdb'],
    });
    searchWeb.mockResolvedValue({ candidates: [], errors: [], facts: undefined });

    const outcome = await processProduct(input);

    expect(outcome.status).toBe('failed');
    expect(outcome.candidates.some((c) => c.rejectedReason?.includes('garden hose'))).toBe(true);
  });

  it('is not re-checked when the barcode already matched confidently', async () => {
    // The whole point of resolving the GTIN first is that those cases are
    // settled; paying a vision call to re-litigate them is a second per product.
    verificationAvailable.mockReturnValue(true);
    lookupBarcodeCached.mockResolvedValue({
      candidates: [candidate('upcitemdb', 0.98)],
      facts,
      errors: [],
      providers: ['upcitemdb'],
    });

    const outcome = await processProduct(input);

    expect(outcome.status).toBe('succeeded');
    expect(verifyProductImage).not.toHaveBeenCalled();
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
