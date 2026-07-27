import { describe, expect, it } from 'vitest';

import { buildFileName, buildFileStem, makeUniqueFileName, slugifyWords } from '@/server/images/naming';

describe('slugifyWords', () => {
  it('title-cases words and joins with underscores', () => {
    expect(slugifyWords('samsung smart tv')).toBe('Samsung_Smart_Tv');
  });

  it('preserves acronyms and model tokens', () => {
    expect(slugifyWords('4K UHD TV')).toBe('4K_UHD_TV');
  });

  it('drops punctuation, keeping the numbers', () => {
    expect(slugifyWords('55" Class (Q60D)')).toBe('55_Class_Q60D');
  });

  it('strips accents rather than the letters under them', () => {
    expect(slugifyWords('Crème Brûlée Kit')).toBe('Creme_Brulee_Kit');
  });
});

describe('buildFileStem', () => {
  const base = { rowNumber: 1, format: 'jpeg' as const };

  it('produces Brand_Product_SKU', () => {
    expect(
      buildFileStem({ ...base, name: '55 Inch Smart TV', brand: 'Samsung', sku: '12345' }),
    ).toBe('Samsung_55_Inch_Smart_TV_12345');
  });

  it('does not repeat a brand already in the product name', () => {
    expect(
      buildFileStem({ ...base, name: 'Samsung 55 Inch Smart TV', brand: 'Samsung', sku: '12345' }),
    ).toBe('Samsung_55_Inch_Smart_TV_12345');
  });

  it('falls back to the barcode, then the row number', () => {
    expect(buildFileStem({ ...base, name: 'Widget', upc: '036000291452' })).toBe(
      'Widget_036000291452',
    );
    expect(buildFileStem({ ...base, name: 'Widget', rowNumber: 7 })).toBe('Widget_007');
  });

  it('keeps the identifier when the descriptive part is too long', () => {
    const stem = buildFileStem({
      ...base,
      name: 'A'.repeat(200),
      brand: 'Acme',
      sku: 'SKU-9911',
    });
    expect(stem.endsWith('_SKU_9911')).toBe(true);
    expect(stem.length).toBeLessThanOrEqual(110);
  });

  it('escapes Windows reserved device names', () => {
    expect(buildFileStem({ ...base, name: 'CON', sku: '1' })).toBe('Item_CON_1');
  });

  it('never produces an empty stem', () => {
    expect(buildFileStem({ ...base, name: '!!!', rowNumber: 3 })).toBe('Product_003');
  });
});

describe('buildFileName', () => {
  it('uses the right extension per format', () => {
    expect(buildFileName({ name: 'Widget', sku: 'A1', rowNumber: 1, format: 'jpeg' })).toBe(
      'Widget_A1.jpg',
    );
    expect(buildFileName({ name: 'Widget', sku: 'A1', rowNumber: 1, format: 'png' })).toBe(
      'Widget_A1.png',
    );
    expect(buildFileName({ name: 'Widget', sku: 'A1', rowNumber: 1, format: 'webp' })).toBe(
      'Widget_A1.webp',
    );
  });
});

describe('makeUniqueFileName', () => {
  it('passes through the first use', () => {
    const taken = new Set<string>();
    expect(makeUniqueFileName('Widget_A1.jpg', taken)).toBe('Widget_A1.jpg');
  });

  it('numbers collisions instead of overwriting', () => {
    const taken = new Set<string>();
    makeUniqueFileName('Widget_A1.jpg', taken);
    expect(makeUniqueFileName('Widget_A1.jpg', taken)).toBe('Widget_A1_2.jpg');
    expect(makeUniqueFileName('Widget_A1.jpg', taken)).toBe('Widget_A1_3.jpg');
  });

  it('treats names as case-insensitive, matching Windows and macOS', () => {
    const taken = new Set<string>();
    makeUniqueFileName('Widget_A1.jpg', taken);
    expect(makeUniqueFileName('widget_a1.jpg', taken)).toBe('widget_a1_2.jpg');
  });
});
