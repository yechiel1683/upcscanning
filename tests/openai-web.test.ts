import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvCache } from '@/lib/env';
import type { ProductEnrichment } from '@/lib/types';
import { openAiWebProvider } from '@/server/providers/search/openai-web';
import type { SearchContext } from '@/server/providers/search';

/**
 * The OpenAI web-search provider is the one that makes a single key cover
 * finding as well as generating, so its parsing has to be robust: the model
 * decides the shape of the reply, and a bad reply must degrade to "no
 * candidates", never to a crash or a fabricated URL.
 */

const enrichment: ProductEnrichment = {
  canonicalTitle: 'Duracell Coppertop AA Batteries 8 Pack',
  brand: 'Duracell',
  model: 'MN1500B8Z',
  searchQueries: ['036000291452'],
  generationPrompt: 'prompt',
  negativeKeywords: [],
  requiredKeywords: ['duracell'],
  source: 'heuristic',
};

const context: SearchContext = {
  upc: '036000291452',
  sku: null,
  name: 'Product 036000291452',
  brand: null,
  model: null,
  enrichment,
  limit: 6,
};

/** Reply as the Responses API would, with the model's text as the payload. */
function mockReply(payload: unknown, asText = false) {
  const text = asText ? String(payload) : JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    }),
    text: async () => '',
  } as unknown as Response;
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'sk-test';
  delete process.env.OPENAI_WEB_SEARCH;
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
  resetEnvCache();
});

describe('openAiWebProvider configuration', () => {
  it('is active whenever an OpenAI key is present', () => {
    expect(openAiWebProvider.isConfigured()).toBe(true);
  });

  it('can be switched off without removing the key', () => {
    process.env.OPENAI_WEB_SEARCH = 'off';
    resetEnvCache();
    expect(openAiWebProvider.isConfigured()).toBe(false);
  });

  it('is a web-tier provider, so it runs after the barcode databases', () => {
    expect(openAiWebProvider.tier).toBe('web');
  });
});

describe('openAiWebProvider results', () => {
  it('turns a well-formed reply into candidates and product facts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockReply({
          imageUrls: [
            'https://cdn.example.com/duracell-aa-8.jpg',
            'https://cdn.example.com/duracell-aa-8-alt.jpg',
          ],
          pageUrl: 'https://shop.example.com/p/duracell-aa-8',
          title: 'Duracell Coppertop AA Batteries, 8 Count',
          brand: 'Duracell',
          model: 'MN1500B8Z',
          category: 'Batteries',
          description: 'Alkaline AA batteries.',
          confidence: 0.9,
        }),
      ),
    );

    const result = await openAiWebProvider.search(context);

    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.sourceUrl).toBe('https://cdn.example.com/duracell-aa-8.jpg');
    expect(result.candidates[0]?.pageUrl).toBe('https://shop.example.com/p/duracell-aa-8');
    expect(result.facts?.title).toBe('Duracell Coppertop AA Batteries, 8 Count');
    expect(result.facts?.model).toBe('MN1500B8Z');
    expect(result.facts?.source).toBe('openai-web');
  });

  it('scales candidate confidence by how sure the model says it is', async () => {
    const call = async (confidence: number) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          mockReply({ imageUrls: ['https://cdn.example.com/a.jpg'], confidence }),
        ),
      );
      const result = await openAiWebProvider.search(context);
      return result.candidates[0]?.providerConfidence ?? 0;
    };

    expect(await call(0.95)).toBeGreaterThan(await call(0.3));
  });

  it('discards a low-confidence identification rather than guessing a name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockReply({
          imageUrls: ['https://cdn.example.com/a.jpg'],
          title: 'Possibly some batteries',
          confidence: 0.2,
        }),
      ),
    );

    const result = await openAiWebProvider.search(context);

    // The picture is still a candidate to be verified; the shaky name is not
    // allowed anywhere near the filename or the export.
    expect(result.candidates).toHaveLength(1);
    expect(result.facts).toBeUndefined();
  });

  it('ignores non-HTTP and malformed URLs the model may invent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockReply({
          imageUrls: [
            'https://cdn.example.com/real.jpg',
            'file:///etc/passwd',
            'not a url',
            '',
            null,
            42,
          ],
          confidence: 0.8,
        }),
      ),
    );

    const result = await openAiWebProvider.search(context);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceUrl).toBe('https://cdn.example.com/real.jpg');
  });

  it('deduplicates repeated URLs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockReply({
          imageUrls: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/a.jpg'],
          confidence: 0.8,
        }),
      ),
    );

    expect((await openAiWebProvider.search(context)).candidates).toHaveLength(1);
  });

  it('respects the candidate limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockReply({
          imageUrls: Array.from({ length: 10 }, (_, i) => `https://cdn.example.com/${i}.jpg`),
          confidence: 0.8,
        }),
      ),
    );

    const result = await openAiWebProvider.search({ ...context, limit: 3 });
    expect(result.candidates).toHaveLength(3);
  });

  it('recovers JSON wrapped in a code fence or prose', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockReply(
          'Here is what I found:\n```json\n{"imageUrls":["https://cdn.example.com/a.jpg"],"confidence":0.9}\n```',
          true,
        ),
      ),
    );

    expect((await openAiWebProvider.search(context)).candidates).toHaveLength(1);
  });

  it('returns nothing when the model finds nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockReply({ imageUrls: [], confidence: 0 })));
    expect((await openAiWebProvider.search(context)).candidates).toHaveLength(0);
  });

  it('returns nothing when the reply is not JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockReply('I could not find that product.', true)));

    const result = await openAiWebProvider.search(context);
    expect(result.candidates).toHaveLength(0);
    expect(result.facts).toBeUndefined();
  });

  it('sends the barcode in the query so the model can identify it', async () => {
    const fetchMock = vi.fn(async () => mockReply({ imageUrls: [], confidence: 0 }));
    vi.stubGlobal('fetch', fetchMock);

    await openAiWebProvider.search(context);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(call[1].body)) as {
      input: string;
      tools: Array<{ type: string }>;
    };

    expect(body.input).toContain('036000291452');
    expect(body.tools[0]?.type).toBe('web_search');
  });
});

describe('reading the product pages the model names', () => {
  /**
   * The reason this exists: a model cannot reproduce a retailer's image URL. It
   * contains an opaque id, so a model that has read the page reconstructs
   * something that looks right and 404s — arriving here as an HTML error page,
   * or as nothing. Which page the product is on, it knows reliably. So the
   * pages get opened and asked what images they publish about themselves.
   */

  /** Reply as a web server would, with an HTML body. */
  function mockPage(html: string) {
    return {
      ok: true,
      status: 200,
      url: '',
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      body: null,
      arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    } as unknown as Response;
  }

  /** First call is the model; every later call is a page fetch. */
  function stubBrowseThenPages(payload: unknown, pages: Record<string, string>) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('api.openai.com')) return mockReply(payload);
        const html = pages[url];
        if (html === undefined) throw new Error(`unexpected fetch: ${url}`);
        return mockPage(html);
      }),
    );
    return calls;
  }

  it('takes the images a page states when the model gives no image URLs', async () => {
    stubBrowseThenPages(
      {
        pageUrls: ['https://shop.example.com/p/pepsi'],
        imageUrls: [],
        confidence: 0.9,
      },
      {
        'https://shop.example.com/p/pepsi':
          '<meta property="og:image" content="https://cdn.example.com/pepsi-real.jpg">',
      },
    );

    const result = await openAiWebProvider.search(context);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.sourceUrl).toBe('https://cdn.example.com/pepsi-real.jpg');
    // Provenance points at the listing it came from, which is what makes the
    // export auditable.
    expect(result.candidates[0]?.pageUrl).toBe('https://shop.example.com/p/pepsi');
  });

  it('ranks a page-published image above one the model typed out', async () => {
    // One exists because a retailer said so; the other because a model recalled
    // it. That difference is the whole point, so it has to reach the ranking.
    stubBrowseThenPages(
      {
        pageUrls: ['https://shop.example.com/p/pepsi'],
        imageUrls: ['https://cdn.example.com/remembered.jpg'],
        confidence: 0.9,
      },
      {
        'https://shop.example.com/p/pepsi':
          '<meta property="og:image" content="https://cdn.example.com/published.jpg">',
      },
    );

    const result = await openAiWebProvider.search(context);
    const remembered = result.candidates.find((c) => c.sourceUrl.includes('remembered'));
    const published = result.candidates.find((c) => c.sourceUrl.includes('published'));

    expect(published!.providerConfidence).toBeGreaterThan(remembered!.providerConfidence);
  });

  it('reads several retailers rather than emptying the budget on one', async () => {
    // Disagreement between retailers is what makes a choice meaningful, and it
    // is also how a discontinued listing gets outvoted by a current one. A page
    // that publishes a gallery must not consume the whole candidate budget
    // before the second retailer is looked at, so the first image of every page
    // is taken before the second image of any of them.
    const gallery = (host: string) =>
      `<script type="application/ld+json">{"@type":"Product","image":[
        "https://${host}/1.jpg","https://${host}/2.jpg","https://${host}/3.jpg",
        "https://${host}/4.jpg","https://${host}/5.jpg","https://${host}/6.jpg"]}</script>`;

    stubBrowseThenPages(
      {
        pageUrls: [
          'https://a.example.com/p',
          'https://b.example.com/p',
          'https://c.example.com/p',
        ],
        confidence: 0.8,
      },
      {
        'https://a.example.com/p': gallery('cdn.a'),
        'https://b.example.com/p': gallery('cdn.b'),
        'https://c.example.com/p': gallery('cdn.c'),
      },
    );

    // The limit is 6 and each page alone could fill it twice over.
    const result = await openAiWebProvider.search(context);
    const hosts = result.candidates.map((c) => new URL(c.sourceUrl).hostname);
    expect(new Set(hosts).size).toBe(3);
    // And the very first candidates are one from each, not three from the first.
    expect(hosts.slice(0, 3)).toEqual(['cdn.a', 'cdn.b', 'cdn.c']);
  });

  it('shrugs off a retailer that blocks the fetch', async () => {
    // A page that 403s a server-side request is normal and says nothing about
    // the product. The other pages, and the barcode tier, are still there.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('api.openai.com')) {
          return mockReply({
            pageUrls: ['https://blocked.example.com/p', 'https://open.example.com/p'],
            confidence: 0.8,
          });
        }
        if (url.includes('blocked')) throw new Error('403');
        return mockPage('<meta property="og:image" content="https://cdn.open/1.jpg">');
      }),
    );

    const result = await openAiWebProvider.search(context);
    expect(result.candidates.map((c) => c.sourceUrl)).toEqual(['https://cdn.open/1.jpg']);
  });

  it('does not open pages when the model already gave enough real images', async () => {
    // Page reads are extra requests. Once the candidate budget is full they buy
    // nothing, and paying for them on every product of a large batch adds up.
    const calls = stubBrowseThenPages(
      {
        pageUrls: ['https://shop.example.com/p/pepsi'],
        imageUrls: Array.from({ length: 6 }, (_, i) => `https://cdn.example.com/${i}.jpg`),
        confidence: 0.9,
      },
      {},
    );

    const result = await openAiWebProvider.search(context);
    expect(result.candidates).toHaveLength(6);
    expect(calls.filter((url) => !url.includes('api.openai.com'))).toEqual([]);
  });
});
