import { describe, expect, it } from 'vitest';

import { extractPageImages, looksLikeHtml } from '@/server/images/page-images';

/**
 * The failure this exists to fix: the web tier asked a browsing model for
 * direct image file URLs, which is the one thing a model cannot do — a
 * retailer's image URL is an opaque id it will confidently reconstruct wrong.
 * Those arrive as HTML error pages ("not an image") or as nothing at all, and a
 * product whose only other candidate is one barcode-database thumbnail fails.
 *
 * What a page states about itself is real by construction. These cover the
 * shapes retailers actually publish, and the two ways reading them goes wrong:
 * missing the product image, or confidently returning the site's logo.
 */

const PAGE = 'https://shop.example.com/p/pepsi-12pk';

describe('extractPageImages', () => {
  it('reads an Open Graph image', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.example.com/pepsi-12pk-large.jpg">
    </head></html>`;
    expect(extractPageImages(html, PAGE)).toEqual([
      { url: 'https://cdn.example.com/pepsi-12pk-large.jpg', source: 'og:image' },
    ]);
  });

  it('accepts the attributes in either order and either quote style', () => {
    // Real pages are not written to one template, and a parser that only
    // matched the canonical order would silently return nothing on half of them.
    const html = `
      <meta content='https://cdn.example.com/a.jpg' property='og:image'/>
      <meta name="twitter:image" content="https://cdn.example.com/b.jpg">`;
    const urls = extractPageImages(html, PAGE).map((image) => image.url);
    expect(urls).toContain('https://cdn.example.com/b.jpg');
  });

  it('reads og:image:secure_url as well', () => {
    const html = `<meta property="og:image:secure_url" content="https://cdn.example.com/s.jpg">`;
    expect(extractPageImages(html, PAGE)[0]?.url).toBe('https://cdn.example.com/s.jpg');
  });

  it('reads JSON-LD, where a page states its full-size image', () => {
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Product","name":"Pepsi",
       "image":["https://cdn.example.com/1.jpg","https://cdn.example.com/2.jpg"]}
    </script>`;
    const urls = extractPageImages(html, PAGE).map((image) => image.url);
    expect(urls).toEqual(['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg']);
  });

  it('reads JSON-LD image given as an ImageObject', () => {
    const html = `<script type="application/ld+json">
      {"@type":"Product","image":{"@type":"ImageObject","url":"https://cdn.example.com/o.jpg"}}
    </script>`;
    expect(extractPageImages(html, PAGE)[0]?.url).toBe('https://cdn.example.com/o.jpg');
  });

  it('reaches into a @graph wrapper', () => {
    // Shopify and several large platforms nest the Product node this way, so a
    // parser that only read the top level would return nothing for them.
    const html = `<script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"WebPage"},
        {"@type":"Product","image":"https://cdn.example.com/g.jpg"}]}
    </script>`;
    expect(extractPageImages(html, PAGE)[0]?.url).toBe('https://cdn.example.com/g.jpg');
  });

  it('resolves a protocol-relative or root-relative URL against the page', () => {
    const html = `
      <meta property="og:image" content="//cdn.example.com/x.jpg">
      <script type="application/ld+json">{"@type":"Product","image":"/img/y.jpg"}</script>`;
    const urls = extractPageImages(html, PAGE).map((image) => image.url);
    expect(urls).toContain('https://cdn.example.com/x.jpg');
    expect(urls).toContain('https://shop.example.com/img/y.jpg');
  });

  it('unescapes an HTML entity in the URL', () => {
    const html = `<meta property="og:image" content="https://cdn.example.com/a.jpg?w=100&amp;h=100">`;
    expect(extractPageImages(html, PAGE)[0]?.url).toBe(
      'https://cdn.example.com/a.jpg?w=100&h=100',
    );
  });

  it('leaves out the site furniture', () => {
    // A logo is on every page and is never the product. Passing one through
    // costs a download, an analysis, and a candidate slot a photograph needed —
    // and if it wins, the catalog gets a logo where a bottle should be.
    const html = `
      <meta property="og:image" content="https://cdn.example.com/site-logo.png">
      <script type="application/ld+json">{"@type":"Product","image":[
        "https://cdn.example.com/icons/favicon.png",
        "https://cdn.example.com/tracking-pixel.gif",
        "https://cdn.example.com/pepsi-real.jpg"]}</script>`;
    const urls = extractPageImages(html, PAGE).map((image) => image.url);
    expect(urls).toEqual(['https://cdn.example.com/pepsi-real.jpg']);
  });

  it('does not return the page itself or another page', () => {
    const html = `
      <meta property="og:image" content="https://shop.example.com/p/other-product">
      <meta property="og:url" content="https://shop.example.com/p/pepsi-12pk">`;
    expect(extractPageImages(html, PAGE)).toEqual([]);
  });

  it('keeps a rendered image that states its size in the query string', () => {
    // Plenty of retailers serve images through a renderer with no extension at
    // all. Requiring one would throw away Scene7 and every service like it.
    const html = `<meta property="og:image" content="https://target.scene7.com/is/image/Target/GUEST_x?wid=1200">`;
    expect(extractPageImages(html, PAGE)[0]?.url).toContain('scene7.com');
  });

  it('does not repeat one image found in two places', () => {
    const html = `
      <meta property="og:image" content="https://cdn.example.com/a.jpg">
      <meta name="twitter:image" content="https://cdn.example.com/a.jpg">
      <script type="application/ld+json">{"@type":"Product","image":"https://cdn.example.com/a.jpg"}</script>`;
    expect(extractPageImages(html, PAGE)).toHaveLength(1);
  });

  it('survives malformed JSON-LD without losing the meta tags', () => {
    // Broken JSON-LD is common. Throwing on it would take the og:image with it.
    const html = `
      <meta property="og:image" content="https://cdn.example.com/good.jpg">
      <script type="application/ld+json">{ this is not json </script>`;
    expect(extractPageImages(html, PAGE)[0]?.url).toBe('https://cdn.example.com/good.jpg');
  });

  it('returns nothing for a page that states nothing', () => {
    expect(extractPageImages('<html><body><p>hello</p></body></html>', PAGE)).toEqual([]);
    expect(extractPageImages('', PAGE)).toEqual([]);
  });

  it('respects the limit', () => {
    const html = `<script type="application/ld+json">{"@type":"Product","image":[
      "https://cdn.example.com/1.jpg","https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.jpg","https://cdn.example.com/4.jpg"]}</script>`;
    expect(extractPageImages(html, PAGE, 2)).toHaveLength(2);
  });

  it('ignores a data URI rather than treating it as a candidate', () => {
    const html = `<meta property="og:image" content="data:image/png;base64,AAAA">`;
    expect(extractPageImages(html, PAGE)).toEqual([]);
  });
});

describe('looksLikeHtml', () => {
  it('recognises the page a hotlink guard sends instead of an image', () => {
    expect(looksLikeHtml(Buffer.from('<!DOCTYPE html><html><head>'))).toBe(true);
    expect(looksLikeHtml(Buffer.from('\n  <html lang="en">'))).toBe(true);
  });

  it('does not mistake image bytes for a page', () => {
    expect(looksLikeHtml(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(looksLikeHtml(Buffer.from('{"error":"nope"}'))).toBe(false);
    expect(looksLikeHtml(Buffer.alloc(0))).toBe(false);
  });
});
