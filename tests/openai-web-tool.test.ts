import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnvCache } from '@/lib/env';

/**
 * The hosted browsing tool has gone by two names across API versions, and
 * sending the wrong one is a 400 rather than a soft failure — it takes the
 * whole web tier down silently. Every product then looks like it simply cannot
 * be found, which is indistinguishable from a barcode nobody has heard of.
 */

const fetchJson = vi.fn();

vi.mock('@/server/lib/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/lib/http')>();
  return { ...actual, fetchJson, withRetry: <T>(fn: () => Promise<T>) => fn() };
});

const { openAiWebProvider, resetWebSearchTool } = await import(
  '@/server/providers/search/openai-web'
);
const { HttpError } = await import('@/server/lib/http');

const context = {
  upc: '036000291452',
  enrichment: { canonicalTitle: 'Duracell Coppertop AA Batteries 8 Pack' },
  limit: 6,
} as never;

const answer = {
  output_text: JSON.stringify({
    imageUrls: ['https://cdn.example.com/duracell.jpg'],
    pageUrl: 'https://example.com/p/1',
    title: 'Duracell Coppertop AA Batteries 8 Pack',
    confidence: 0.9,
  }),
};

function toolOf(call: unknown): string {
  const [, options] = call as [string, { body: string }];
  return (JSON.parse(options.body) as { tools: Array<{ type: string }> }).tools[0]!.type;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetWebSearchTool();
  process.env.OPENAI_API_KEY = 'sk-test';
  resetEnvCache();
});

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  resetEnvCache();
  vi.restoreAllMocks();
});

describe('openai-web tool negotiation', () => {
  it('uses the current tool name when the account accepts it', async () => {
    fetchJson.mockResolvedValue(answer);

    const result = await openAiWebProvider.search(context);

    expect(result.candidates).toHaveLength(1);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(toolOf(fetchJson.mock.calls[0])).toBe('web_search');
  });

  it('falls back to the older name rather than losing the tier', async () => {
    fetchJson
      .mockRejectedValueOnce(new HttpError("Invalid value: 'web_search'", 400))
      .mockResolvedValueOnce(answer);

    const result = await openAiWebProvider.search(context);

    expect(result.candidates).toHaveLength(1);
    expect(toolOf(fetchJson.mock.calls[1])).toBe('web_search_preview');
  });

  it('remembers which name worked instead of paying for the discovery twice', async () => {
    fetchJson
      .mockRejectedValueOnce(new HttpError("Invalid value: 'web_search'", 400))
      .mockResolvedValue(answer);

    await openAiWebProvider.search(context);
    fetchJson.mockClear();
    await openAiWebProvider.search(context);

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(toolOf(fetchJson.mock.calls[0])).toBe('web_search_preview');
  });

  it('does not retry a failure that has nothing to do with the tool', async () => {
    // Re-sending a rejected key or an exhausted quota under a different tool
    // name burns a second call to be told the same thing.
    fetchJson.mockRejectedValue(new HttpError('You exceeded your current quota', 429));

    await expect(openAiWebProvider.search(context)).rejects.toThrow(/quota/);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('gives up honestly when neither name is accepted', async () => {
    fetchJson.mockRejectedValue(new HttpError("Invalid value: 'web_search'", 400));

    await expect(openAiWebProvider.search(context)).rejects.toThrow();
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });
});
