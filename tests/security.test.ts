import { describe, expect, it } from 'vitest';

import { assertPublicUrl, HttpError } from '@/server/lib/http';
import { sanitizeKey } from '@/server/storage';
import { sanitizeFileName } from '@/server/api/upload';

/**
 * Candidate image URLs come from third-party search results and from user
 * spreadsheets, and storage keys are built from product names. Both are
 * untrusted input reaching a network client and a filesystem respectively.
 */

describe('assertPublicUrl', () => {
  it('allows ordinary public URLs', () => {
    expect(() => assertPublicUrl('https://cdn.example.com/a.jpg')).not.toThrow();
    expect(() => assertPublicUrl('http://images.retailer.co.uk/p/1.png')).not.toThrow();
  });

  it('blocks loopback and link-local addresses', () => {
    for (const url of [
      'http://127.0.0.1/admin',
      'http://localhost:3000/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow(HttpError);
    }
  });

  it('blocks private network ranges', () => {
    for (const url of [
      'http://10.0.0.5/x.jpg',
      'http://192.168.1.1/x.jpg',
      'http://172.16.0.1/x.jpg',
      'http://172.31.255.255/x.jpg',
    ]) {
      expect(() => assertPublicUrl(url), url).toThrow(HttpError);
    }
  });

  it('allows public addresses that merely look adjacent to private ones', () => {
    expect(() => assertPublicUrl('http://172.32.0.1/x.jpg')).not.toThrow();
    expect(() => assertPublicUrl('http://11.0.0.1/x.jpg')).not.toThrow();
  });

  it('blocks cloud metadata hostnames', () => {
    expect(() => assertPublicUrl('http://metadata.google.internal/')).toThrow(HttpError);
    expect(() => assertPublicUrl('http://foo.internal/')).toThrow(HttpError);
  });

  it('refuses non-HTTP schemes', () => {
    expect(() => assertPublicUrl('file:///etc/passwd')).toThrow(HttpError);
    expect(() => assertPublicUrl('ftp://example.com/a.jpg')).toThrow(HttpError);
  });

  it('refuses malformed input', () => {
    expect(() => assertPublicUrl('not a url')).toThrow(HttpError);
  });
});

describe('sanitizeKey', () => {
  it('keeps a normal key intact', () => {
    expect(sanitizeKey('batches/abc/images/Widget_A1.jpg')).toBe('batches/abc/images/Widget_A1.jpg');
  });

  it('strips traversal segments', () => {
    expect(sanitizeKey('../../etc/passwd')).toBe('etc/passwd');
    expect(sanitizeKey('batches/../../../root/.ssh/id_rsa')).toBe('batches/root/.ssh/id_rsa');
  });

  it('replaces characters that are unsafe in a path', () => {
    expect(sanitizeKey('batches/a b/c:d*e?.jpg')).toBe('batches/a_b/c_d_e_.jpg');
  });

  it('refuses a key that sanitises down to nothing', () => {
    expect(() => sanitizeKey('../..')).toThrow();
    expect(() => sanitizeKey('')).toThrow();
  });
});

describe('sanitizeFileName', () => {
  it('drops any directory component', () => {
    expect(sanitizeFileName('../../evil.csv')).toBe('evil.csv');
    expect(sanitizeFileName('C:\\Users\\me\\list.xlsx')).toBe('list.xlsx');
  });

  it('keeps ordinary names readable', () => {
    expect(sanitizeFileName('Spring 2026 Price List.xlsx')).toBe('Spring 2026 Price List.xlsx');
  });

  it('never returns an empty name', () => {
    expect(sanitizeFileName('///')).toBe('upload');
  });
});
