import { beforeEach, describe, expect, it } from 'vitest';

import { mergeFacts, type ProductFacts } from '@/lib/types';
import { resetEnvCache } from '@/lib/env';
import { parseBarcodeList } from '@/server/ingest/barcode-list';
import { applyFacts } from '@/server/pipeline/run-product-job';
import { buildFileName } from '@/server/images/naming';
import { generationStatus } from '@/server/providers/generate';
import { understandingProvider } from '@/server/providers/llm/enrichment';
import { providerStatus } from '@/server/providers/search';

/**
 * The end-to-end promise for someone holding nothing but barcodes and one
 * OpenAI key: paste the numbers, get named images back.
 */

function withEnv(vars: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
  }
}

beforeEach(() => {
  resetEnvCache();
});

describe('parseBarcodeList', () => {
  it('turns a pasted column of barcodes into products', () => {
    const result = parseBarcodeList('036000291452\n885911574518\n5449000000996');

    expect(result.products).toHaveLength(3);
    expect(result.products.map((p) => p.upc)).toEqual([
      '036000291452',
      '885911574518',
      '5449000000996',
    ]);
    // Names are placeholders the pipeline replaces once each code resolves.
    expect(result.products[0]?.name).toBe('Product 036000291452');
  });

  it('numbers rows sequentially even when lines are skipped', () => {
    const result = parseBarcodeList('036000291452\n\n   \n885911574518');
    expect(result.products.map((p) => p.rowNumber)).toEqual([1, 2]);
  });

  it('accepts a trailing label after a comma or tab', () => {
    const result = parseBarcodeList('036000291452, Duracell AA 8 Pack\n885911574518\tDeWalt Drill');

    expect(result.products[0]?.name).toBe('Duracell AA 8 Pack');
    expect(result.products[0]?.upc).toBe('036000291452');
    expect(result.products[1]?.name).toBe('DeWalt Drill');
  });

  it('restores leading zeros lost to a spreadsheet copy-paste', () => {
    const result = parseBarcodeList('36000291452');
    expect(result.products[0]?.upc).toBe('036000291452');
    expect(result.warnings[0]?.message).toMatch(/leading zeros/);
  });

  it('drops duplicates and says which line they duplicated', () => {
    const result = parseBarcodeList('036000291452\n036000291452');
    expect(result.products).toHaveLength(1);
    expect(result.skipped[0]?.message).toBe('Duplicate of line 1.');
  });

  it('skips lines that are not barcodes', () => {
    const result = parseBarcodeList('036000291452\nplease send images\n123');

    expect(result.products).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0]?.message).toMatch(/no digits/);
    expect(result.skipped[1]?.message).toMatch(/too short/);
  });

  it('keeps a barcode whose check digit is wrong, since it may still resolve', () => {
    const result = parseBarcodeList('036000291453');
    expect(result.products).toHaveLength(1);
    expect(result.warnings[0]?.message).toMatch(/check digit/);
  });

  it('enforces the batch cap', () => {
    const lines = ['036000291452', '885911574518', '5449000000996', '190199098701'];
    const result = parseBarcodeList(lines.join('\n'), 2);

    expect(result.products).toHaveLength(2);
    expect(result.skipped.some((s) => /limit/.test(s.message))).toBe(true);
  });

  it('produces a mapping that the batch endpoint accepts', () => {
    expect(parseBarcodeList('036000291452').mapping).toEqual({ upc: 'UPC' });
  });
});

describe('mergeFacts', () => {
  it('fills each field from the first source that has it', () => {
    const merged = mergeFacts([
      { title: 'Duracell AA 8 Pack', source: 'upcitemdb' },
      { title: 'Different name', brand: 'Duracell', model: 'MN1500B8Z', source: 'go-upc' },
    ]);

    expect(merged?.title).toBe('Duracell AA 8 Pack');
    expect(merged?.brand).toBe('Duracell');
    expect(merged?.model).toBe('MN1500B8Z');
    expect(merged?.source).toBe('upcitemdb+go-upc');
  });

  it('returns nothing when no source had anything', () => {
    expect(mergeFacts([undefined, undefined])).toBeUndefined();
  });
});

describe('applyFacts', () => {
  const bare = {
    name: 'Product 036000291452',
    brand: null,
    model: null,
    category: null,
    description: null,
    upc: '036000291452',
    sku: null,
  };

  const facts: ProductFacts = {
    title: 'Duracell Coppertop AA Batteries 8 Pack',
    brand: 'Duracell',
    model: 'MN1500B8Z',
    category: 'Batteries',
    description: 'Alkaline AA batteries',
    source: 'upcitemdb',
  };

  it('replaces a barcode placeholder with the real product name', () => {
    const resolved = applyFacts(bare, facts);

    expect(resolved.name).toBe('Duracell Coppertop AA Batteries 8 Pack');
    expect(resolved.brand).toBe('Duracell');
    expect(resolved.model).toBe('MN1500B8Z');
  });

  it('never overwrites a name the supplier actually supplied', () => {
    const supplied = { ...bare, name: 'AA Batteries, 8ct' };
    expect(applyFacts(supplied, facts).name).toBe('AA Batteries, 8ct');
  });

  it('still backfills empty fields around a supplied name', () => {
    const supplied = { ...bare, name: 'AA Batteries, 8ct' };
    const resolved = applyFacts(supplied, facts);

    expect(resolved.name).toBe('AA Batteries, 8ct');
    expect(resolved.brand).toBe('Duracell');
    expect(resolved.category).toBe('Batteries');
  });

  it('leaves the placeholder alone when nothing resolved', () => {
    expect(applyFacts(bare, undefined).name).toBe('Product 036000291452');
  });

  it('turns a bare barcode into a descriptive filename', () => {
    const resolved = applyFacts(bare, facts);
    const fileName = buildFileName({
      name: resolved.name,
      brand: resolved.brand,
      sku: null,
      upc: bare.upc,
      rowNumber: 1,
      format: 'jpeg',
    });

    // This is the whole point: not Product_036000291452.jpg.
    expect(fileName).toBe('Duracell_Coppertop_AA_Batteries_8_Pack_036000291452.jpg');
  });
});

describe('configuration with only an OpenAI key', () => {
  const onlyOpenAi = {
    OPENAI_API_KEY: 'sk-test',
    ANTHROPIC_API_KEY: undefined,
    SERPAPI_KEY: undefined,
    GOOGLE_CSE_API_KEY: undefined,
    GOOGLE_CSE_ENGINE_ID: undefined,
    BING_SEARCH_API_KEY: undefined,
    IMAGE_GENERATION_PROVIDER: undefined,
  };

  it('activates a web image source', () => {
    withEnv(onlyOpenAi, () => {
      const web = providerStatus().filter((p) => p.kind === 'web' && p.configured);
      expect(web.map((p) => p.name)).toContain('openai-web');
    });
  });

  it('uses the key for product identification instead of heuristics', () => {
    withEnv(onlyOpenAi, () => {
      expect(understandingProvider().provider).toBe('openai');
    });
  });

  it('enables fallback generation without extra configuration', () => {
    withEnv(onlyOpenAi, () => {
      const status = generationStatus();
      expect(status.enabled).toBe(true);
      expect(status.provider).toBe('openai');
    });
  });

  it('prefers Anthropic for identification when both keys exist', () => {
    withEnv({ ...onlyOpenAi, ANTHROPIC_API_KEY: 'sk-ant-test' }, () => {
      expect(understandingProvider().provider).toBe('anthropic');
    });
  });
});

describe('configuration with no keys at all', () => {
  const noKeys = {
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    SERPAPI_KEY: undefined,
    GOOGLE_CSE_API_KEY: undefined,
    GOOGLE_CSE_ENGINE_ID: undefined,
    BING_SEARCH_API_KEY: undefined,
    GOUPC_API_KEY: undefined,
    IMAGE_GENERATION_PROVIDER: undefined,
  };

  it('still offers keyless barcode databases', () => {
    withEnv(noKeys, () => {
      const keyless = providerStatus().filter((p) => p.configured && p.keyless);
      expect(keyless.length).toBeGreaterThanOrEqual(4);
      expect(keyless.every((p) => p.kind === 'barcode')).toBe(true);
    });
  });

  it('reports generation as off, with a reason naming the fix', () => {
    withEnv(noKeys, () => {
      const status = generationStatus();
      expect(status.enabled).toBe(false);
      expect(status.reason).toMatch(/OPENAI_API_KEY/);
    });
  });

  it('falls back to heuristic identification', () => {
    withEnv(noKeys, () => {
      expect(understandingProvider().provider).toBe('heuristic');
    });
  });
});
