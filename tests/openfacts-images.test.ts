import { afterEach, describe, expect, it, vi } from 'vitest';

import { openFoodFactsProvider } from '@/server/providers/search/barcode';
import type { ProductEnrichment } from '@/lib/types';
import type { SearchContext } from '@/server/providers/search';

/**
 * Open Food Facts holds every photograph anyone ever uploaded for a barcode.
 * Only the one a contributor marked "front" was ever read — so for a popular
 * product, one person's phone snapshot on a kitchen counter was the entire
 * result, while four clean shots of the same bottle sat unread in the same
 * response. Scoring can only pick the best picture out of the ones it is shown.
 *
 * The risk in the other direction is inventing URLs, which is the failure this
 * pipeline exists to avoid: the path contains a split form of the barcode that
 * must not be reconstructed. So the directory is only ever taken from a URL the
 * API itself returned.
 */

const enrichment: ProductEnrichment = {
  canonicalTitle: 'Pepsi',
  brand: 'Pepsi',
  searchQueries: ['012000001307'],
  generationPrompt: '',
  negativeKeywords: [],
  requiredKeywords: [],
  source: 'heuristic',
};

const context: SearchContext = {
  upc: '012000001307',
  sku: null,
  name: 'Pepsi',
  brand: null,
  model: null,
  enrichment,
  limit: 12,
};

const BASE = 'https://images.openfoodfacts.org/images/products/001/200/000/1307';

function mockProduct(product: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: 1, product }),
      text: async () => '',
    })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Open Food Facts image discovery', () => {
  it('offers the other uploads, not just the selected front', async () => {
    mockProduct({
      product_name: 'Pepsi',
      image_url: `${BASE}/front_en.4.400.jpg`,
      images: { '1': {}, '2': {}, '3': {}, front_en: {} },
    });

    const result = await openFoodFactsProvider.search(context);
    const urls = result.candidates.map((candidate) => candidate.sourceUrl);

    expect(urls).toContain(`${BASE}/front_en.4.400.jpg`);
    expect(urls).toContain(`${BASE}/3.jpg`);
    expect(urls).toContain(`${BASE}/2.jpg`);
    expect(urls).toContain(`${BASE}/1.jpg`);
  });

  it('still puts the selected front first', async () => {
    // A contributor chose it, which is a real signal — it is just not the only
    // one worth having. The ranking decides from there.
    mockProduct({
      product_name: 'Pepsi',
      image_url: `${BASE}/front_en.4.400.jpg`,
      images: { '1': {}, '2': {}, front_en: {} },
    });

    const result = await openFoodFactsProvider.search(context);
    expect(result.candidates[0]?.sourceUrl).toBe(`${BASE}/front_en.4.400.jpg`);
  });

  it('offers the newest upload before the oldest', async () => {
    // Upload numbers increase over time, so the highest is the most recent
    // photograph of the packaging — which is what "the newest picture" means
    // for a database with no dates on anything.
    mockProduct({
      product_name: 'Pepsi',
      image_url: `${BASE}/front_en.4.400.jpg`,
      images: { '1': {}, '2': {}, '9': {}, '10': {} },
    });

    const result = await openFoodFactsProvider.search(context);
    const extras = result.candidates
      .map((candidate) => candidate.sourceUrl)
      .filter((url) => /\/\d+\.jpg$/.test(url));

    expect(extras[0]).toBe(`${BASE}/10.jpg`);
    expect(extras[1]).toBe(`${BASE}/9.jpg`);
  });

  it('does not treat a selected crop as another photograph', async () => {
    // front_en, nutrition_fr and the rest are crops of the numbered uploads.
    // Offering them would be offering the same picture several times, which
    // fills the candidate budget without adding a single new option.
    mockProduct({
      product_name: 'Pepsi',
      image_url: `${BASE}/front_en.4.400.jpg`,
      images: { '1': {}, front_en: {}, nutrition_fr: {}, ingredients_en: {} },
    });

    const result = await openFoodFactsProvider.search(context);
    const urls = result.candidates.map((candidate) => candidate.sourceUrl);
    expect(urls.some((url) => url.includes('nutrition'))).toBe(false);
    expect(urls.some((url) => url.includes('ingredients'))).toBe(false);
  });

  it('never builds a URL when the API gave it no path to build from', async () => {
    // The directory contains a split form of the barcode. Reconstructing it
    // would be inventing URLs — exactly the failure that made the web tier
    // return HTML error pages instead of pictures.
    mockProduct({ product_name: 'Pepsi', images: { '1': {}, '2': {} } });

    const result = await openFoodFactsProvider.search(context);
    expect(result.candidates).toEqual([]);
  });

  it('is bounded, so one product cannot become a crawl of a photo album', async () => {
    const images: Record<string, unknown> = {};
    for (let i = 1; i <= 40; i += 1) images[String(i)] = {};
    mockProduct({ product_name: 'Pepsi', image_url: `${BASE}/front_en.4.400.jpg`, images });

    const result = await openFoodFactsProvider.search(context);
    const extras = result.candidates.filter((candidate) =>
      /\/\d+\.jpg$/.test(candidate.sourceUrl),
    );
    expect(extras.length).toBeLessThanOrEqual(4);
  });

  it('behaves exactly as before for a product with no extra uploads', async () => {
    mockProduct({
      product_name: 'Pepsi',
      image_url: `${BASE}/front_en.4.400.jpg`,
      images: { front_en: {} },
    });

    const result = await openFoodFactsProvider.search(context);
    expect(result.candidates).toHaveLength(1);
  });

  it('survives a response with no images object at all', async () => {
    mockProduct({ product_name: 'Pepsi', image_url: `${BASE}/front_en.4.400.jpg` });
    const result = await openFoodFactsProvider.search(context);
    expect(result.candidates).toHaveLength(1);
  });
});
