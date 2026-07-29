import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { DEFAULT_RENDER_OPTIONS, type RenderOptions } from '@/lib/types';
import { analyseBorder, buildForegroundMask, featherMask } from '@/server/images/background';
import { analyseImage, renderProductImage } from '@/server/images/render';

/**
 * These exercise the real sharp pipeline rather than mocking it. The pipeline
 * is the product, and its failure modes (a cutout that eats the subject, a
 * canvas that comes out the wrong size) are only visible in real pixels.
 */

/** A red box centred on a white field — stands in for a catalog product shot. */
async function studioPhoto(
  width = 800,
  height = 800,
  box = { left: 250, top: 250, width: 300, height: 300 },
): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: {
          create: {
            width: box.width,
            height: box.height,
            channels: 3,
            background: { r: 200, g: 30, b: 40 },
          },
        },
        left: box.left,
        top: box.top,
      },
    ])
    .png()
    .toBuffer();
}

/** A photo with no backdrop at all — every pixel is different. */
async function noisyPhoto(width = 400, height = 400): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) {
    // Deterministic pseudo-noise so the test is reproducible.
    pixels[i] = (i * 2654435761) % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** Wide body on a narrow stem — the shape a bar-shaped shadow gets wrong. */
async function wideBodyNarrowBase(size = 900): Promise<Buffer> {
  return sharp({
    create: { width: size, height: size, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([
      {
        input: {
          create: { width: 600, height: 220, channels: 3, background: { r: 200, g: 30, b: 40 } },
        },
        left: 150,
        top: 180,
      },
      {
        input: {
          create: { width: 90, height: 300, channels: 3, background: { r: 200, g: 30, b: 40 } },
        },
        left: 405,
        top: 400,
      },
    ])
    .png()
    .toBuffer();
}

async function rawOf(buffer: Buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/** Read a single pixel from an encoded image. */
async function pixelAt(buffer: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const index = (y * info.width + x) * info.channels;
  return {
    r: data[index] ?? 0,
    g: data[index + 1] ?? 0,
    b: data[index + 2] ?? 0,
    a: data[index + 3] ?? 255,
  };
}

describe('analyseBorder', () => {
  it('reports a uniform white backdrop with near-zero variance', async () => {
    const { data, width, height, channels } = await rawOf(await studioPhoto());
    const border = analyseBorder(data, width, height, channels);

    expect(border.r).toBeGreaterThan(250);
    expect(border.g).toBeGreaterThan(250);
    expect(border.b).toBeGreaterThan(250);
    expect(border.variance).toBeLessThan(10);
  });

  it('reports high variance for a photo with no backdrop', async () => {
    const { data, width, height, channels } = await rawOf(await noisyPhoto());
    const border = analyseBorder(data, width, height, channels);
    expect(border.variance).toBeGreaterThan(1000);
  });
});

describe('buildForegroundMask', () => {
  it('isolates the product and finds its bounding box', async () => {
    const { data, width, height, channels } = await rawOf(
      await studioPhoto(800, 800, { left: 250, top: 250, width: 300, height: 300 }),
    );
    const mask = buildForegroundMask(data, width, height, { channels });

    expect(mask.bounds).not.toBeNull();
    // The box occupies 300/800 of each axis, allowing a pixel or two of slack
    // from the mask edge.
    expect(mask.bounds!.left).toBeGreaterThanOrEqual(248);
    expect(mask.bounds!.left).toBeLessThanOrEqual(252);
    expect(mask.bounds!.width).toBeGreaterThanOrEqual(298);
    expect(mask.bounds!.width).toBeLessThanOrEqual(304);

    // 300x300 of 800x800 is 14% of the frame.
    expect(mask.foregroundRatio).toBeGreaterThan(0.13);
    expect(mask.foregroundRatio).toBeLessThan(0.16);
    expect(mask.confidence).toBeGreaterThan(0.8);
  });

  it('refuses to trust itself on a photo with no backdrop', async () => {
    const { data, width, height, channels } = await rawOf(await noisyPhoto());
    const mask = buildForegroundMask(data, width, height, { channels });
    expect(mask.confidence).toBeLessThan(0.55);
  });

  it('reports low confidence when there is nothing to remove', async () => {
    const blank = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();

    const { data, width, height, channels } = await rawOf(blank);
    const mask = buildForegroundMask(data, width, height, { channels });

    expect(mask.foregroundRatio).toBeLessThan(0.02);
    expect(mask.confidence).toBeLessThan(0.2);
  });
});

describe('featherMask', () => {
  it('softens a hard edge into a gradient', () => {
    const width = 9;
    const height = 9;
    const mask = new Uint8Array(width * height);
    // Fill a 3x3 block in the middle.
    for (let y = 3; y < 6; y += 1) for (let x = 3; x < 6; x += 1) mask[y * width + x] = 255;

    const feathered = featherMask(mask, width, height, 1);

    // Centre stays solid, the ring around it becomes partial.
    expect(feathered[4 * width + 4]).toBe(255);
    const edge = feathered[4 * width + 2] ?? 0;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });
});

describe('analyseImage', () => {
  it('reports dimensions and framing for a studio photo', async () => {
    const analysis = await analyseImage(await studioPhoto(1000, 1000));
    expect(analysis.width).toBe(1000);
    expect(analysis.height).toBe(1000);
    expect(analysis.borderVariance).toBeLessThan(10);
    expect(analysis.maskConfidence).toBeGreaterThan(0.8);
  });
});

describe('renderProductImage', () => {
  const options: RenderOptions = { ...DEFAULT_RENDER_OPTIONS, width: 1000, height: 1000 };

  it('produces exactly the requested canvas size', async () => {
    const result = await renderProductImage({ buffer: await studioPhoto(), options });
    const metadata = await sharp(result.buffer).metadata();

    expect(result.width).toBe(1000);
    expect(result.height).toBe(1000);
    expect(metadata.width).toBe(1000);
    expect(metadata.height).toBe(1000);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('normalises differently sized and shaped sources to one output size', async () => {
    const sources = await Promise.all([
      studioPhoto(600, 900, { left: 200, top: 300, width: 200, height: 300 }),
      studioPhoto(1400, 700, { left: 500, top: 200, width: 400, height: 300 }),
      studioPhoto(500, 500, { left: 100, top: 100, width: 300, height: 300 }),
    ]);

    for (const source of sources) {
      const result = await renderProductImage({ buffer: source, options });
      const metadata = await sharp(result.buffer).metadata();
      expect(metadata.width).toBe(1000);
      expect(metadata.height).toBe(1000);
    }
  });

  it('puts the product on a white background', async () => {
    const result = await renderProductImage({ buffer: await studioPhoto(), options });

    const corner = await pixelAt(result.buffer, 5, 5);
    expect(corner.r).toBeGreaterThan(248);
    expect(corner.g).toBeGreaterThan(248);
    expect(corner.b).toBeGreaterThan(248);

    // The product itself should still be red in the middle.
    const centre = await pixelAt(result.buffer, 500, 500);
    expect(centre.r).toBeGreaterThan(150);
    expect(centre.g).toBeLessThan(90);
  });

  it('leaves the requested padding around the product', async () => {
    const padded: RenderOptions = { ...options, padding: 0.15, dropShadow: false };
    const result = await renderProductImage({ buffer: await studioPhoto(), options: padded });

    // 15% of 1000px is 150px, so a point at x=100 must still be background.
    const inMargin = await pixelAt(result.buffer, 100, 500);
    expect(inMargin.r).toBeGreaterThan(240);
  });

  it('emits a PNG with real transparency when asked for a transparent background', async () => {
    const transparent: RenderOptions = {
      ...options,
      background: 'transparent',
      format: 'png',
      dropShadow: false,
    };
    const result = await renderProductImage({ buffer: await studioPhoto(), options: transparent });

    expect(result.mimeType).toBe('image/png');
    const corner = await pixelAt(result.buffer, 5, 5);
    expect(corner.a).toBeLessThan(20);

    const centre = await pixelAt(result.buffer, 500, 500);
    expect(centre.a).toBeGreaterThan(200);
  });

  it('actually erases the backdrop rather than reporting that it did', async () => {
    // A coloured backdrop with a gradient across it, and both details are
    // load-bearing. Coloured, because every other fixture here is a subject on
    // white composited back onto white, where a cutout that quietly did nothing
    // is pixel-identical to one that worked — which is how a broken alpha
    // channel survived in this pipeline unnoticed. Graded, because `trim` will
    // crop a perfectly uniform backdrop by itself, so a flat colour lets the
    // fallback path clean up after the bug and the test passes anyway. Only a
    // backdrop that trimming cannot remove proves the mask was applied.
    const gradient = Buffer.alloc(800 * 800 * 3);
    for (let y = 0; y < 800; y += 1) {
      for (let x = 0; x < 800; x += 1) {
        const index = (y * 800 + x) * 3;
        gradient[index] = 20 + Math.round((y / 800) * 24);
        gradient[index + 1] = 60 + Math.round((y / 800) * 20);
        gradient[index + 2] = 200 + Math.round((x / 800) * 18);
      }
    }

    const onBlue = await sharp(gradient, { raw: { width: 800, height: 800, channels: 3 } })
      .composite([
        {
          input: {
            create: {
              width: 300,
              height: 300,
              channels: 3,
              background: { r: 200, g: 30, b: 40 },
            },
          },
          left: 250,
          top: 250,
        },
      ])
      .png()
      .toBuffer();

    const result = await renderProductImage({ buffer: onBlue, options });
    expect(result.metrics.backgroundRemoved).toBe(true);

    const { data, info } = await sharp(result.buffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let backdrop = 0;
    const total = info.width * info.height;
    for (let i = 0; i < total; i += 1) {
      const base = i * info.channels;
      // Anything in the backdrop's blue family, across the whole gradient.
      const dr = data[base]! - 32;
      const dg = data[base + 1]! - 70;
      const db = data[base + 2]! - 209;
      if (dr * dr + dg * dg + db * db <= 3 * 55 * 55) backdrop += 1;
    }
    expect(backdrop / total).toBeLessThan(0.001);
  });

  it('falls back to PNG when transparency is requested with a JPEG format', async () => {
    const conflicting: RenderOptions = { ...options, background: 'transparent', format: 'jpeg' };
    const result = await renderProductImage({ buffer: await studioPhoto(), options: conflicting });
    expect(result.mimeType).toBe('image/png');
  });

  it('honours the webp format', async () => {
    const webp: RenderOptions = { ...options, format: 'webp' };
    const result = await renderProductImage({ buffer: await studioPhoto(), options: webp });
    expect(result.mimeType).toBe('image/webp');
    expect((await sharp(result.buffer).metadata()).format).toBe('webp');
  });

  it('does not cut out a photo it cannot confidently segment', async () => {
    const result = await renderProductImage({ buffer: await noisyPhoto(600, 600), options });
    // The important guarantee: we still produce a correctly sized image rather
    // than punching a hole through the subject.
    expect(result.metrics.backgroundRemoved).toBe(false);
    expect(result.width).toBe(1000);
    expect((await sharp(result.buffer).metadata()).width).toBe(1000);
  });

  it('preserves an existing alpha cutout', async () => {
    const cutout = await sharp({
      create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: {
            create: { width: 150, height: 150, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 1 } },
          },
          left: 125,
          top: 125,
        },
      ])
      .png()
      .toBuffer();

    const result = await renderProductImage({
      buffer: cutout,
      options: { ...options, background: 'transparent', format: 'png', dropShadow: false },
    });

    expect(result.metrics.backgroundRemoved).toBe(true);
    expect((await pixelAt(result.buffer, 5, 5)).a).toBeLessThan(20);
    expect((await pixelAt(result.buffer, 500, 500)).a).toBeGreaterThan(200);
  });

  it('renders a studio sweep background without leaving it pure white', async () => {
    const studio: RenderOptions = { ...options, background: 'studio' };
    const result = await renderProductImage({ buffer: await studioPhoto(), options: studio });

    // The sweep darkens toward the frame edge; the corner should not be 255.
    const corner = await pixelAt(result.buffer, 2, 998);
    expect(corner.r).toBeLessThan(252);
    expect(corner.r).toBeGreaterThan(220);
  });

  it('applies the AI badge without changing the canvas size', async () => {
    const result = await renderProductImage({
      buffer: await studioPhoto(),
      options,
      aiBadge: true,
    });

    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(1000);
    expect(metadata.height).toBe(1000);

    // The badge sits bottom-right and is dark on a light background.
    const badgePixel = await pixelAt(result.buffer, 900, 965);
    expect(badgePixel.r).toBeLessThan(180);
  });

  it('places the contact shadow under the base, not as a bar across the frame', async () => {
    // The first implementation squashed the whole silhouette into a strip and
    // blurred it, producing a hard grey rectangle spanning the frame — a wide
    // product's outline stays wide all the way down. The shadow must instead
    // track where the product actually meets the ground.
    const result = await renderProductImage({
      buffer: await wideBodyNarrowBase(),
      options: { ...options, dropShadow: true },
    });

    const { data, info } = await sharp(result.buffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Find the darkest row below the product — the shadow's core.
    let widest = 0;
    let darkest = 255;
    for (let row = Math.round(info.height * 0.86); row < info.height; row += 1) {
      let count = 0;
      for (let x = 0; x < info.width; x += 1) {
        const value = data[(row * info.width + x) * info.channels] ?? 255;
        if (value < 248) count += 1;
        if (value < darkest) darkest = value;
      }
      if (count > widest) widest = count;
    }

    // There is a visible shadow...
    expect(widest).toBeGreaterThan(0);
    // ...it is soft rather than a solid slab...
    expect(darkest).toBeGreaterThan(140);
    // ...and it tracks the ~90px base, not the ~600px body above it. The bar
    // this replaced spanned about 77% of the frame.
    expect(widest).toBeLessThan(info.width * 0.4);
  });

  it('leaves the backdrop clean when the shadow is turned off', async () => {
    const result = await renderProductImage({
      buffer: await studioPhoto(),
      options: { ...options, dropShadow: false, padding: 0.15 },
    });

    const belowProduct = await pixelAt(result.buffer, 500, 960);
    expect(belowProduct.r).toBeGreaterThan(250);
  });

  it('reports metrics describing what it did', async () => {
    const result = await renderProductImage({ buffer: await studioPhoto(800, 800), options });
    expect(result.metrics.sourceWidth).toBe(800);
    expect(result.metrics.sourceHeight).toBe(800);
    expect(result.metrics.backgroundRemoved).toBe(true);
    expect(result.metrics.borderVariance).toBeLessThan(10);
  });
});
