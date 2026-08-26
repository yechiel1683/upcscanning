import { describe, expect, it } from 'vitest';

import { canonicalImageKey, largerVariants } from '@/server/images/variants';

/**
 * This is string surgery on other people's URLs, which fails in two directions.
 *
 * Too timid and the product is lost: a 185x400 thumbnail is below the
 * resolution floor, so it is rejected, and the row comes back empty even though
 * the full-size master was one substitution away. Too eager and every candidate
 * costs an extra 404 before the original is tried, on every product, forever.
 *
 * So the rules only fire on patterns that actually mean a size, and a URL that
 * matches nothing must come back with nothing.
 */

describe('largerVariants', () => {
  it('asks Open Food Facts for the original instead of its 400px render', () => {
    // The failure that prompted this: OFF's "display" size is 400px on the long
    // edge, which for a tall wrapper is 185x400.
    expect(
      largerVariants(
        'https://images.openfoodfacts.org/images/products/002/840/019/9148/front_en.4.400.jpg',
      ),
    ).toEqual([
      'https://images.openfoodfacts.org/images/products/002/840/019/9148/front_en.4.full.jpg',
    ]);
  });

  it('covers the sibling databases, which share the scheme', () => {
    for (const host of [
      'images.openbeautyfacts.org',
      'images.openproductsfacts.org',
      'images.openpetfoodfacts.org',
    ]) {
      const [first] = largerVariants(`https://${host}/images/products/1/front_en.4.200.jpg`);
      expect(first).toContain('front_en.4.full.jpg');
    }
  });

  it('leaves an Open Food Facts URL that is already full alone', () => {
    expect(
      largerVariants('https://images.openfoodfacts.org/images/products/1/front_en.4.full.jpg'),
    ).toEqual([]);
  });

  it('raises the size Walmart was asked to render', () => {
    const [first] = largerVariants(
      'https://i5.walmartimages.com/asr/abc.jpeg?odnHeight=180&odnWidth=180&odnBg=FFFFFF',
    );
    expect(first).toContain('odnHeight=2000');
    expect(first).toContain('odnWidth=2000');
    // And leaves the parameters it does not understand untouched.
    expect(first).toContain('odnBg=FFFFFF');
  });

  it('strips an Amazon transform to get the untransformed original', () => {
    expect(largerVariants('https://m.media-amazon.com/images/I/71abc._SL160_.jpg')).toEqual([
      'https://m.media-amazon.com/images/I/71abc.jpg',
    ]);
    expect(
      largerVariants('https://images-na.ssl-images-amazon.com/images/I/71abc._AC_SX300_.jpg'),
    ).toEqual(['https://images-na.ssl-images-amazon.com/images/I/71abc.jpg']);
  });

  it('leaves an Amazon URL with no transform alone', () => {
    expect(largerVariants('https://m.media-amazon.com/images/I/71abc.jpg')).toEqual([]);
  });

  it('raises Scene7 render dimensions', () => {
    const [first] = largerVariants(
      'https://target.scene7.com/is/image/Target/GUEST_abc?wid=180&hei=180&fmt=pjpeg',
    );
    expect(first).toContain('wid=2000');
    expect(first).toContain('hei=2000');
  });

  it('strips a Shopify size suffix', () => {
    expect(largerVariants('https://cdn.shopify.com/s/files/1/x/bottle_180x180.jpg')).toEqual([
      'https://cdn.shopify.com/s/files/1/x/bottle.jpg',
    ]);
  });

  it('raises a generic width parameter on a host it has never heard of', () => {
    const [first] = largerVariants('https://cdn.somestore.example/img/a.jpg?w=200&h=200');
    expect(first).toContain('w=2000');
    expect(first).toContain('h=2000');
  });

  it('does not shrink a request that already asks for something large', () => {
    // Rewriting these would be churn at best and a downgrade at worst.
    expect(largerVariants('https://cdn.somestore.example/img/a.jpg?w=3000')).toEqual([]);
    expect(
      largerVariants('https://i5.walmartimages.com/asr/abc.jpeg?odnHeight=2000&odnWidth=2000'),
    ).toEqual([]);
  });

  it('never invents a parameter a URL did not have', () => {
    // Adding ?w=2000 to an arbitrary URL is guessing at an API, and the wasted
    // request is paid on every candidate of every product.
    expect(largerVariants('https://cdn.somestore.example/img/a.jpg')).toEqual([]);
  });

  it('does not invent parameters on a host it does recognise either', () => {
    // Recognising the host says how to *adjust* a size request, not that one
    // can be bolted onto a URL that never made it. These are direct asset
    // links, and appending a render parameter is inventing an API for them.
    expect(largerVariants('https://i5.walmartimages.com/asr/abc.jpeg')).toEqual([]);
    expect(largerVariants('https://target.scene7.com/is/image/Target/GUEST_abc')).toEqual([]);
  });

  it('does not mistake other numbers for sizes', () => {
    // A path full of digits is normal — product codes, dates, shard ids.
    expect(largerVariants('https://cdn.example.com/2024/03/12345/photo.jpg')).toEqual([]);
    expect(largerVariants('https://cdn.example.com/img/a.jpg?sku=1200&qty=180')).toEqual([]);
  });

  it('survives input that is not a URL at all', () => {
    expect(largerVariants('')).toEqual([]);
    expect(largerVariants('not a url')).toEqual([]);
    expect(largerVariants('data:image/png;base64,AAAA')).toEqual([]);
  });

  it('returns at most two guesses', () => {
    // Each one is a request that might 404. The point is to save a product, not
    // to enumerate a CDN.
    const many = largerVariants(
      'https://i5.walmartimages.com/asr/abc.jpeg?odnHeight=180&odnWidth=180&w=100&h=100&size=50',
    );
    expect(many.length).toBeLessThanOrEqual(2);
  });
});

describe('canonicalImageKey', () => {
  /**
   * The same photograph reaches this pipeline from several providers at several
   * sizes. Offering both as "alternatives" would show somebody one picture
   * twice and ask them to choose, which reads as a bug rather than a choice.
   */

  it('collapses the sizes of one Open Food Facts image', () => {
    const small =
      'https://images.openfoodfacts.org/images/products/002/840/019/9148/front_en.4.400.jpg';
    const full =
      'https://images.openfoodfacts.org/images/products/002/840/019/9148/front_en.4.full.jpg';
    expect(canonicalImageKey(small)).toBe(canonicalImageKey(full));
  });

  it('collapses Amazon transforms of one asset', () => {
    expect(canonicalImageKey('https://m.media-amazon.com/images/I/71abc._SL160_.jpg')).toBe(
      canonicalImageKey('https://m.media-amazon.com/images/I/71abc.jpg'),
    );
  });

  it('collapses render sizes asked for in the query string', () => {
    expect(
      canonicalImageKey('https://i5.walmartimages.com/asr/abc.jpeg?odnHeight=180&odnWidth=180'),
    ).toBe(canonicalImageKey('https://i5.walmartimages.com/asr/abc.jpeg?odnHeight=2000'));
    expect(canonicalImageKey('https://cdn.x.example/a.jpg?w=200&h=200')).toBe(
      canonicalImageKey('https://cdn.x.example/a.jpg'),
    );
  });

  it('collapses a Shopify size suffix', () => {
    expect(canonicalImageKey('https://cdn.shopify.com/s/files/1/x/bottle_180x180.jpg')).toBe(
      canonicalImageKey('https://cdn.shopify.com/s/files/1/x/bottle.jpg'),
    );
  });

  it('keeps two genuinely different photographs apart', () => {
    // The failure that matters in the other direction: collapsing everything
    // would hide the real second option and leave a review row with no way out
    // but rejection.
    expect(
      canonicalImageKey('https://images.openfoodfacts.org/p/1/front_en.4.400.jpg'),
    ).not.toBe(canonicalImageKey('https://images.openfoodfacts.org/p/1/front_fr.7.400.jpg'));
    expect(canonicalImageKey('https://a.example/x.jpg')).not.toBe(
      canonicalImageKey('https://b.example/x.jpg'),
    );
    expect(canonicalImageKey('https://m.media-amazon.com/images/I/71abc.jpg')).not.toBe(
      canonicalImageKey('https://m.media-amazon.com/images/I/81xyz.jpg'),
    );
  });

  it('ignores a www prefix and letter case', () => {
    expect(canonicalImageKey('https://WWW.Example.com/A.JPG')).toBe(
      canonicalImageKey('https://example.com/a.jpg'),
    );
  });

  it('does not throw on input that is not a URL', () => {
    expect(canonicalImageKey('not a url')).toBe('not a url');
    expect(canonicalImageKey('')).toBe('');
  });
});
