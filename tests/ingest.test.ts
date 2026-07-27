import { describe, expect, it } from 'vitest';

import { detectColumnMapping, mappingIsUsable, normaliseHeader } from '@/server/ingest/column-mapper';
import {
  cleanText,
  deriveName,
  isValidGtinChecksum,
  normalisePrice,
  normaliseUpc,
  normaliseUrl,
} from '@/server/ingest/normalize';
import { buildProducts, readCsv } from '@/server/ingest/parser';

describe('normaliseHeader', () => {
  it('strips punctuation and case', () => {
    expect(normaliseHeader('UPC / Barcode')).toBe('upcbarcode');
    expect(normaliseHeader('  Item_Number ')).toBe('itemnumber');
  });
});

describe('detectColumnMapping', () => {
  it('maps a typical supplier export', () => {
    const mapping = detectColumnMapping([
      'Item Number',
      'UPC Code',
      'Product Name',
      'Brand',
      'Model #',
      'Long Description',
      'Category',
      'Unit Price',
    ]);

    expect(mapping).toMatchObject({
      sku: 'Item Number',
      upc: 'UPC Code',
      name: 'Product Name',
      brand: 'Brand',
      model: 'Model #',
      description: 'Long Description',
      category: 'Category',
      price: 'Unit Price',
    });
  });

  it('recognises barcode synonyms', () => {
    expect(detectColumnMapping(['EAN13', 'Title']).upc).toBe('EAN13');
    expect(detectColumnMapping(['GTIN-12', 'Title']).upc).toBe('GTIN-12');
    expect(detectColumnMapping(['Barcode Number', 'Title']).upc).toBe('Barcode Number');
  });

  it('never assigns one header to two fields', () => {
    const mapping = detectColumnMapping(['MPN', 'Description', 'Name']);
    const used = Object.values(mapping);
    expect(new Set(used).size).toBe(used.length);
  });

  it('does not mistake an image column for a SKU', () => {
    const mapping = detectColumnMapping(['Image URL', 'Product Title']);
    expect(mapping.imageUrl).toBe('Image URL');
    expect(mapping.sku).toBeUndefined();
  });

  it('reports whether a mapping can identify products', () => {
    expect(mappingIsUsable({ name: 'Title' })).toBe(true);
    expect(mappingIsUsable({ upc: 'UPC' })).toBe(true);
    expect(mappingIsUsable({ price: 'Price' })).toBe(false);
  });
});

describe('GTIN validation', () => {
  it('accepts real barcodes', () => {
    // A published UPC-A and the Coca-Cola EAN-13.
    expect(isValidGtinChecksum('036000291452')).toBe(true);
    expect(isValidGtinChecksum('885911574518')).toBe(true);
    expect(isValidGtinChecksum('5449000000996')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidGtinChecksum('036000291453')).toBe(false);
    expect(isValidGtinChecksum('5449000000997')).toBe(false);
  });

  it('rejects wrong-length input', () => {
    expect(isValidGtinChecksum('12345')).toBe(false);
  });
});

describe('normaliseUpc', () => {
  it('restores leading zeros Excel dropped', () => {
    // 036000291452 is a valid UPC-A; Excel would store it as 36000291452.
    const result = normaliseUpc('36000291452');
    expect(result?.value).toBe('036000291452');
    expect(result?.valid).toBe(true);
    expect(result?.note).toMatch(/leading zeros/);
  });

  it('strips separators', () => {
    expect(normaliseUpc('0-36000-29145-2')?.value).toBe('036000291452');
    expect(normaliseUpc(' 885911574518 ')?.value).toBe('885911574518');
  });

  it('keeps an invalid barcode but flags it', () => {
    const result = normaliseUpc('123456789990');
    expect(result?.valid).toBe(false);
    expect(result?.value).toBe('123456789990');
    expect(result?.note).toMatch(/check digit/);
  });

  it('expands scientific notation', () => {
    // Excel renders long barcodes this way once the column is numeric.
    expect(normaliseUpc('3.6000291452e+10')?.value).toBe('036000291452');
  });
});

describe('normalisePrice', () => {
  it('handles currency symbols and separators', () => {
    expect(normalisePrice('$1,299.99')).toBe(1299.99);
    expect(normalisePrice('1.234,56')).toBe(1234.56);
    expect(normalisePrice('USD 45')).toBe(45);
    expect(normalisePrice(19.5)).toBe(19.5);
  });

  it('rejects junk', () => {
    expect(normalisePrice('call for pricing')).toBeUndefined();
    expect(normalisePrice('')).toBeUndefined();
  });
});

describe('normaliseUrl', () => {
  it('adds a missing scheme', () => {
    expect(normaliseUrl('cdn.example.com/a.jpg')).toBe('https://cdn.example.com/a.jpg');
  });

  it('rejects prose', () => {
    expect(normaliseUrl('see attached')).toBeUndefined();
  });
});

describe('cleanText', () => {
  it('drops Excel error values', () => {
    expect(cleanText('#N/A')).toBeUndefined();
    expect(cleanText('#REF!')).toBeUndefined();
    expect(cleanText('n/a')).toBeUndefined();
  });

  it('collapses whitespace', () => {
    expect(cleanText('  Samsung   TV  ')).toBe('Samsung TV');
  });
});

describe('deriveName', () => {
  it('prefers an explicit name', () => {
    expect(deriveName({ name: 'Widget', brand: 'Acme' })).toBe('Widget');
  });

  it('falls back to brand and model', () => {
    expect(deriveName({ brand: 'DeWalt', model: 'DCD771C2' })).toBe('DeWalt DCD771C2');
  });

  it('falls back to the first clause of a description', () => {
    expect(deriveName({ description: 'Cordless drill, 20V, two batteries' })).toBe('Cordless drill');
  });

  it('gives up gracefully with only a barcode', () => {
    expect(deriveName({ upc: '036000291452' })).toBe('Product 036000291452');
  });
});

describe('CSV ingestion', () => {
  it('parses a clean file into products', () => {
    const csv = [
      'Item Number,UPC,Product Name,Brand,Description,Price',
      '12345,036000291452,Duracell AA Batteries 8 Pack,Duracell,Alkaline AA batteries,$14.99',
      '54321,885911574518,DeWalt 20V Drill,DeWalt,Cordless drill driver kit,129.99',
    ].join('\n');

    const result = buildProducts(readCsv(Buffer.from(csv)));

    expect(result.products).toHaveLength(2);
    expect(result.products[0]).toMatchObject({
      rowNumber: 2,
      sku: '12345',
      upc: '036000291452',
      name: 'Duracell AA Batteries 8 Pack',
      brand: 'Duracell',
      price: 14.99,
    });
    expect(result.products[1]?.price).toBe(129.99);
  });

  it('skips a title row above the real headers', () => {
    const csv = [
      'ACME WHOLESALE — SPRING PRICE LIST',
      '',
      'SKU,Product Name,Brand',
      'A1,Widget,Acme',
    ].join('\n');

    const result = buildProducts(readCsv(Buffer.from(csv)));

    expect(result.headers).toEqual(['SKU', 'Product Name', 'Brand']);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]?.name).toBe('Widget');
  });

  it('drops duplicates by barcode and reports them', () => {
    const csv = [
      'UPC,Product Name',
      '885911574518,DeWalt 20V Drill',
      '885911574518,DeWalt 20V Max Cordless Drill',
    ].join('\n');

    const result = buildProducts(readCsv(Buffer.from(csv)));

    expect(result.products).toHaveLength(1);
    expect(result.skipped[0]?.message).toMatch(/Duplicate of row 2 \(same barcode\)/);
  });

  it('skips rows with nothing to identify them by', () => {
    const csv = ['SKU,Product Name,Price', ',,19.99', 'A1,Widget,5.00'].join('\n');

    const result = buildProducts(readCsv(Buffer.from(csv)));

    expect(result.products).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.rowNumber).toBe(2);
  });

  it('keeps unmapped columns as extra data', () => {
    const csv = ['SKU,Product Name,Warehouse,Case Pack', 'A1,Widget,NJ-3,24'].join('\n');

    const result = buildProducts(readCsv(Buffer.from(csv)));

    expect(result.products[0]?.extra).toEqual({ Warehouse: 'NJ-3', 'Case Pack': '24' });
  });

  it('honours a caller-supplied mapping override', () => {
    const csv = ['Code,Label', 'A1,Widget'].join('\n');

    const result = buildProducts(readCsv(Buffer.from(csv)), {
      mappingOverride: { sku: 'Code', name: 'Label' },
    });

    expect(result.products[0]).toMatchObject({ sku: 'A1', name: 'Widget' });
  });

  it('enforces the per-batch product cap', () => {
    const rows = ['SKU,Product Name'];
    for (let i = 0; i < 10; i += 1) rows.push(`A${i},Widget ${i}`);

    const result = buildProducts(readCsv(Buffer.from(rows.join('\n'))), { maxProducts: 4 });

    expect(result.products).toHaveLength(4);
    expect(result.skipped.length).toBe(6);
    expect(result.skipped[0]?.message).toMatch(/4-product limit/);
  });

  it('deduplicates repeated header names', () => {
    const csv = ['Name,Name,Price', 'A,B,1'].join('\n');
    const sheet = readCsv(Buffer.from(csv));
    expect(sheet.headers).toEqual(['Name', 'Name (2)', 'Price']);
  });
});
