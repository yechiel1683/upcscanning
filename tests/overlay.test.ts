import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { DEFAULT_RENDER_OPTIONS } from '@/lib/types';
import { buildForegroundMask } from '@/server/images/background';
import { analyseOverlays } from '@/server/images/overlay';
import { renderProductImage } from '@/server/images/render';

/**
 * The case this exists for is a retail listing image: a real product photo with
 * a marketing banner composited onto it. Getting it wrong in either direction is
 * costly — miss the banner and the catalog carries somebody else's advertising;
 * mistake a product for a banner and the catalog loses the product.
 *
 * So the fixtures are built to be genuinely hard rather than convenient. The
 * "photograph" is shaded and noisy the way a real one is, and includes a case
 * designed to be as banner-like as a real product ever gets: a plain carton,
 * square to camera, filling its own bounding box.
 */

const WIDTH = 240;
const HEIGHT = 240;
const CHANNELS = 3;

/** Deterministic noise, so a failure is always reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function blankCanvas(): Uint8Array {
  const data = new Uint8Array(WIDTH * HEIGHT * CHANNELS).fill(255);
  return data;
}

function put(data: Uint8Array, x: number, y: number, r: number, g: number, b: number): void {
  const index = (y * WIDTH + x) * CHANNELS;
  data[index] = Math.max(0, Math.min(255, Math.round(r)));
  data[index + 1] = Math.max(0, Math.min(255, Math.round(g)));
  data[index + 2] = Math.max(0, Math.min(255, Math.round(b)));
}

/**
 * A photographed bottle: rounded silhouette, a vertical lighting gradient, a
 * specular highlight down one side, and sensor noise. Nothing about it is flat.
 */
function drawBottle(data: Uint8Array, left: number, right: number, top: number, bottom: number) {
  const random = makeRandom(7);
  const centreX = (left + right) / 2;
  const halfWidth = (right - left) / 2;

  for (let y = top; y < bottom; y += 1) {
    // Taper towards the neck so the shape is not a rectangle.
    const progress = (y - top) / (bottom - top);
    const shoulder = progress < 0.18 ? 0.45 + progress * 3 : 1;
    const rowHalf = halfWidth * Math.min(1, shoulder);

    for (let x = Math.ceil(centreX - rowHalf); x < centreX + rowHalf; x += 1) {
      if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) continue;
      // Curvature shading across the body, plus a highlight band.
      const across = (x - (centreX - rowHalf)) / (rowHalf * 2);
      const curve = Math.sin(across * Math.PI);
      const highlight = Math.exp(-(((across - 0.3) / 0.12) ** 2)) * 55;
      const vertical = progress * 26;
      const base = 68 + curve * 42 + highlight + vertical + (random() - 0.5) * 6;
      put(data, x, y, base, base + 4, base + 11);
    }
  }
}

/** A drawn banner: two flat fills and flat white text. */
function drawBanner(data: Uint8Array, left: number, right: number, top: number, bottom: number) {
  const split = Math.round(top + (bottom - top) * 0.55);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      if (y < split) put(data, x, y, 22, 58, 148);
      else put(data, x, y, 18, 118, 214);
    }
  }
  // Text: flat white blocks standing in for letterforms.
  for (let row = 0; row < 3; row += 1) {
    const textTop = top + 12 + row * 18;
    for (let y = textTop; y < textTop + 9; y += 1) {
      for (let x = left + 10; x < right - 12; x += 1) {
        if (Math.floor((x - left) / 7) % 2 === 0) put(data, x, y, 255, 255, 255);
      }
    }
  }
}

/** A plain carton: rectangular and square to camera, but photographed. */
function drawCarton(data: Uint8Array, left: number, right: number, top: number, bottom: number) {
  const random = makeRandom(23);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const across = (x - left) / (right - left);
      const down = (y - top) / (bottom - top);
      // Even a flat face has a lighting falloff and print texture.
      const base = 176 - across * 34 - down * 14 + (random() - 0.5) * 9;
      put(data, x, y, base, base - 6, base - 14);
    }
  }
}

function analyse(data: Uint8Array) {
  const mask = buildForegroundMask(data, WIDTH, HEIGHT, { channels: CHANNELS });
  return {
    mask,
    overlays: analyseOverlays(data, WIDTH, HEIGHT, CHANNELS, mask.mask),
  };
}

describe('analyseOverlays', () => {
  it('leaves a clean pack shot alone', () => {
    const data = blankCanvas();
    drawBottle(data, 90, 150, 40, 210);

    const { overlays } = analyse(data);
    expect(overlays.panels).toHaveLength(0);
    expect(overlays.panelShareOfForeground).toBe(0);
    expect(overlays.productMask).toBeNull();
  });

  it('finds a marketing banner composited beside the product', () => {
    const data = blankCanvas();
    drawBottle(data, 130, 190, 40, 210);
    drawBanner(data, 0, 96, 60, 180);

    const { overlays } = analyse(data);
    expect(overlays.panels).toHaveLength(1);
    expect(overlays.panelShareOfForeground).toBeGreaterThan(0.3);
  });

  it('reports the product on its own once the banner is excluded', () => {
    const data = blankCanvas();
    drawBottle(data, 130, 190, 40, 210);
    drawBanner(data, 0, 96, 60, 180);

    const { overlays } = analyse(data);
    // The subject that survives must be the bottle, not the banner: it starts
    // well to the right of where the banner ends.
    expect(overlays.productBounds).not.toBeNull();
    expect(overlays.productBounds!.left).toBeGreaterThan(96);
    expect(overlays.productBounds!.width).toBeLessThan(90);
  });

  it('does not mistake a plain carton for a banner', () => {
    // The hardest false positive: rectangular, square to camera, filling its
    // bounding box. Only its shading says it is a photograph.
    const data = blankCanvas();
    drawCarton(data, 70, 170, 55, 190);

    const { overlays } = analyse(data);
    expect(overlays.panels).toHaveLength(0);
    expect(overlays.productMask).toBeNull();
  });

  it('keeps the image intact when the "panel" is all there is', () => {
    // A product that really is a flat drawn rectangle would otherwise be
    // stripped to nothing. Losing the product is far worse than keeping a
    // banner, so the analysis stands down.
    const data = blankCanvas();
    drawBanner(data, 60, 180, 50, 190);

    const { overlays } = analyse(data);
    expect(overlays.panels.length).toBeGreaterThan(0);
    expect(overlays.productMask).toBeNull();
    expect(overlays.productBounds).toBeNull();
  });

  it('ignores a speck too small to be furniture', () => {
    const data = blankCanvas();
    drawBottle(data, 90, 150, 40, 210);
    drawBanner(data, 4, 16, 4, 16);

    const { overlays } = analyse(data);
    expect(overlays.panels).toHaveLength(0);
  });
});

/**
 * The end of the chain, in real pixels. Detecting a banner is only worth
 * anything if it does not reach the customer's catalog.
 */
describe('renderProductImage with a composited banner', () => {
  async function toPng(data: Uint8Array): Promise<Buffer> {
    return sharp(Buffer.from(data), { raw: { width: WIDTH, height: HEIGHT, channels: CHANNELS } })
      .png()
      .toBuffer();
  }

  /** Pixels close to either of the banner's two blues. */
  async function countBannerPixels(buffer: Buffer): Promise<{ banner: number; total: number }> {
    const { data, info } = await sharp(buffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const fills = [
      [22, 58, 148],
      [18, 118, 214],
    ];
    let banner = 0;
    const total = info.width * info.height;
    for (let i = 0; i < total; i += 1) {
      const base = i * info.channels;
      const r = data[base]!;
      const g = data[base + 1]!;
      const b = data[base + 2]!;
      for (const [fr, fg, fb] of fills) {
        const dr = r - fr!;
        const dg = g - fg!;
        const db = b - fb!;
        if (dr * dr + dg * dg + db * db <= 3 * 40 * 40) {
          banner += 1;
          break;
        }
      }
    }
    return { banner, total };
  }

  it('keeps the banner out of the rendered catalog image', async () => {
    const data = blankCanvas();
    drawBottle(data, 130, 190, 40, 210);
    drawBanner(data, 0, 96, 60, 180);

    const render = await renderProductImage({
      buffer: await toPng(data),
      options: { ...DEFAULT_RENDER_OPTIONS, width: 600, height: 600 },
    });

    expect(render.metrics.overlayRemoved).toBe(true);
    const { banner, total } = await countBannerPixels(render.buffer);
    expect(banner / total).toBeLessThan(0.002);
  });

  it('still renders the product itself, rather than an empty frame', async () => {
    const data = blankCanvas();
    drawBottle(data, 130, 190, 40, 210);
    drawBanner(data, 0, 96, 60, 180);

    const render = await renderProductImage({
      buffer: await toPng(data),
      options: { ...DEFAULT_RENDER_OPTIONS, width: 600, height: 600 },
    });

    // The bottle is dark against a white canvas; a frame that lost the product
    // to the cutout would be almost entirely white.
    const { data: pixels, info } = await sharp(render.buffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let subject = 0;
    const total = info.width * info.height;
    for (let i = 0; i < total; i += 1) {
      if (pixels[i * info.channels]! < 200) subject += 1;
    }
    expect(subject / total).toBeGreaterThan(0.05);
  });

  it('leaves a clean pack shot untouched', async () => {
    const data = blankCanvas();
    drawBottle(data, 90, 150, 40, 210);

    const render = await renderProductImage({
      buffer: await toPng(data),
      options: { ...DEFAULT_RENDER_OPTIONS, width: 600, height: 600 },
    });

    expect(render.metrics.overlayRemoved).toBe(false);
  });
});
