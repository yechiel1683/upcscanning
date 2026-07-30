import sharp from 'sharp';

import { env } from '@/lib/env';
import type { BackgroundStyle, OutputFormat, RenderOptions } from '@/lib/types';
import { decodeOptions } from './limits';
import {
  analyseBorder,
  buildForegroundMask,
  featherMask,
  type MaskResult,
} from './background';
import { analyseOverlays, eraseOverlays } from './overlay';

/**
 * The rendering pipeline.
 *
 * Every image — sourced or generated — goes through the same steps so a
 * catalog assembled from a dozen different websites still looks like one shoot:
 *
 *   orient -> analyse -> cut out -> trim to subject -> resize into a padded
 *   frame -> composite onto the chosen backdrop -> contact shadow -> encode
 *
 * sharp does the pixel work; the analysis that decides *whether* to cut out
 * lives in ./background so it can be tested without decoding real files.
 */

/** Cap on the analysis pass. Flood fill is O(pixels); 640px is plenty to decide. */
const ANALYSIS_MAX_EDGE = 640;

/**
 * Candidate scoring runs smaller.
 *
 * Segmentation feeds two different jobs. The render needs a mask precise enough
 * to cut along, and pays 640px for it. Scoring a candidate needs four numbers —
 * how uniform the border is, how much of the frame the subject fills, how much
 * detail it has, how much of it is promotional artwork — and those do not move:
 * measured on the same photograph, 448px reports a foreground ratio of 0.282
 * against 0.280 at 640, and the same confidence. It costs 154ms instead of
 * 335ms, on every candidate of every product.
 */
const SCORING_MAX_EDGE = 448;

/** Below this mask confidence we leave the original background alone. */
const CUTOUT_CONFIDENCE_THRESHOLD = 0.55;

export interface RenderInput {
  buffer: Buffer;
  options: RenderOptions;
  /** Draw the "AI GENERATED" corner badge. */
  aiBadge?: boolean;
}

export interface RenderMetrics {
  sourceWidth: number;
  sourceHeight: number;
  borderVariance: number;
  foregroundRatio?: number;
  maskConfidence?: number;
  detail: number;
  backgroundRemoved: boolean;
  /** A composited marketing panel was excluded from the subject. */
  overlayRemoved: boolean;
  upscaled: boolean;
}

export interface RenderResult {
  buffer: Buffer;
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
  metrics: RenderMetrics;
}

const MIME: Record<OutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

export function mimeTypeFor(format: OutputFormat): string {
  return MIME[format];
}

/** Analyse a decoded image without producing output — used to score candidates. */
export async function analyseImage(buffer: Buffer): Promise<{
  width: number;
  height: number;
  hasAlpha: boolean;
  borderVariance: number;
  foregroundRatio: number;
  maskConfidence: number;
  detail: number;
  overlayShare: number;
}> {
  const image = sharp(buffer, decodeOptions()).rotate();
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error('Image has no readable dimensions');

  const { data, info } = await downscaleToRaw(buffer, SCORING_MAX_EDGE);
  const border = analyseBorder(data, info.width, info.height, info.channels);
  const mask = buildForegroundMask(data, info.width, info.height, { channels: info.channels });
  const overlays = analyseOverlays(data, info.width, info.height, info.channels, mask.mask);

  return {
    width,
    height,
    hasAlpha: Boolean(metadata.hasAlpha),
    borderVariance: border.variance,
    foregroundRatio: mask.foregroundRatio,
    maskConfidence: mask.confidence,
    detail: measureDetail(data, info.width, info.height, info.channels),
    // Only report furniture we could actually separate from a product. When the
    // whole foreground reads as one drawn rectangle we cannot tell a banner from
    // a flat-packaged product, and penalising the image would be a guess.
    overlayShare: overlays.productMask ? overlays.panelShareOfForeground : 0,
  };
}

export async function renderProductImage(input: RenderInput): Promise<RenderResult> {
  const { options } = input;

  const metadata = await sharp(input.buffer, decodeOptions()).metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (!sourceWidth || !sourceHeight) throw new Error('Image has no readable dimensions');

  // --- analysis on a downscaled copy -------------------------------------
  const { data: smallData, info: smallInfo } = await downscaleToRaw(input.buffer);
  const border = analyseBorder(smallData, smallInfo.width, smallInfo.height, smallInfo.channels);
  const detail = measureDetail(smallData, smallInfo.width, smallInfo.height, smallInfo.channels);

  const alreadyTransparent = Boolean(metadata.hasAlpha) && (await hasMeaningfulAlpha(input.buffer));

  // --- segment ------------------------------------------------------------
  // Done before touching the full-resolution image, because the mask is what
  // says how large the source actually needs to be: a product filling half the
  // frame needs twice the pixels of one filling all of it, and everything past
  // that is thrown away by the final resize anyway.
  let silhouetteMask: MaskResult | null = null;
  let overlaysErased = false;
  let fillLeaked = false;
  let backgroundRemoved = false;
  let foregroundRatio: number | undefined;
  let maskConfidence: number | undefined;
  let overlayRemoved = false;

  if (alreadyTransparent) {
    // The source is already a cutout; trimming its alpha is enough.
    backgroundRemoved = true;
  } else if (options.removeBackground || options.background === 'transparent') {
    const raw = buildForegroundMask(smallData, smallInfo.width, smallInfo.height, {
      channels: smallInfo.channels,
    });

    // Drop any composited marketing furniture before the cutout, so what gets
    // trimmed and centred is the product rather than the product plus somebody
    // else's banner. Erasing the panels and segmenting again — rather than just
    // subtracting them from the mask — is what lets the cutout proceed at all:
    // confidence is judged partly on how uniform the frame border is, and a
    // banner reaching the edge is exactly what ruins it.
    const overlays = analyseOverlays(
      smallData,
      smallInfo.width,
      smallInfo.height,
      smallInfo.channels,
      raw.mask,
    );

    let mask = raw;
    if (overlays.productMask) {
      const cleaned = eraseOverlays(
        smallData,
        smallInfo.channels,
        raw.mask,
        overlays.productMask,
        raw.backgroundColor,
      );
      mask = buildForegroundMask(cleaned, smallInfo.width, smallInfo.height, {
        channels: smallInfo.channels,
        // The leak check cannot be re-derived here — erasing a panel shrinks
        // the mask on purpose, which is indistinguishable from the fill having
        // eaten the product. The first pass's verdict, taken on the untouched
        // photograph, is the one that counts, and it is applied at the gate.
        inkBounds: null,
      });
      overlaysErased = true;
    }

    foregroundRatio = mask.foregroundRatio;
    maskConfidence = mask.confidence;

    fillLeaked = raw.fillLeaked;

    if (!fillLeaked && mask.confidence >= CUTOUT_CONFIDENCE_THRESHOLD && mask.bounds) {
      silhouetteMask = mask;
      backgroundRemoved = true;
    }
  }

  // --- fit into the padded frame -----------------------------------------
  const padding = options.dropShadow ? Math.max(options.padding, 0.06) : options.padding;
  const innerWidth = Math.max(1, Math.round(options.width * (1 - padding * 2)));
  const innerHeight = Math.max(1, Math.round(options.height * (1 - padding * 2)));

  // --- decode once, at the size the output actually needs ------------------
  const workEdge = chooseWorkingEdge(Math.max(innerWidth, innerHeight), silhouetteMask);
  const work = await sharp(input.buffer, decodeOptions())
    .rotate()
    .resize(workEdge, workEdge, { fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const workWidth = work.info.width;
  const workHeight = work.info.height;
  const fromWork = () =>
    sharp(work.data, { raw: { width: workWidth, height: workHeight, channels: 4 } });

  let subject = fromWork();
  let subjectWidth = workWidth;

  if (alreadyTransparent) {
    subject = subject.trim({ threshold: 1 });
  } else if (silhouetteMask?.bounds) {
    const mask = silhouetteMask;
    overlayRemoved = overlaysErased;

    // Carry the mask as the *alpha* of an RGBA image and erase with `dest-in`.
    //
    // The obvious route — resize the mask to a one-channel buffer and
    // `joinChannel` it onto the source — does not work, and fails silently,
    // which is worse. Given one-channel raw input and no explicit output format
    // sharp promotes greyscale to three-channel sRGB, so the buffer is three
    // times the expected length; `joinChannel` then either misreads it or drops
    // the band entirely, and the result is a fully opaque image. No error is
    // raised anywhere.
    const feathered = featherMask(mask.mask, mask.width, mask.height, 1);
    const maskRgba = new Uint8Array(mask.width * mask.height * 4);
    for (let i = 0; i < feathered.length; i += 1) maskRgba[i * 4 + 3] = feathered[i]!;
    // Crop to the bounds the segmentation already measured rather than encoding
    // the whole frame and asking sharp to `trim` it back down. Trimming a
    // full-resolution PNG was, on its own, the single most expensive step in
    // this pipeline — 2.5s of a 5.9s render on a 4000px source — and it was
    // rediscovering a rectangle we had known all along.
    //
    // Both sides are cropped before compositing, and the order is not a matter
    // of taste: sharp runs a fixed pipeline rather than the sequence you write,
    // so a `.composite()` before an `.extract()` still composites last, against
    // an image that has already shrunk. The mask no longer lines up and the
    // whole operation throws.
    const crop = scaleBounds(mask.bounds!, mask.width, mask.height, workWidth, workHeight);
    const maskImage = await sharp(Buffer.from(maskRgba), {
      raw: { width: mask.width, height: mask.height, channels: 4 },
    })
      .resize(workWidth, workHeight, { fit: 'fill', kernel: 'cubic' })
      .extract(crop)
      .png()
      .toBuffer();

    subject = fromWork()
      .extract(crop)
      .composite([{ input: maskImage, blend: 'dest-in' }]);
    subjectWidth = crop.width;
  } else if (border.variance < 400) {
    // Not confident enough to cut out. If the backdrop is at least uniform we
    // can still trim the flat margins so framing stays consistent.
    //
    // But trimming is the same judgement as the fill, made cruder: it discards
    // whatever sits within a threshold of the corner pixel. On the images where
    // the fill ate a pale product, a threshold of 12 eats it again — the bottle
    // that defeated segmentation is six levels off the backdrop. So when the
    // fill is known to have leaked, trim tightly enough to take only the margin
    // and leave the product where it is.
    subject = subject.trim({ threshold: fillLeaked ? 3 : 12 });
  }

  const fit = {
    fit: 'inside' as const,
    // Never blow a small source up beyond its native size — an upscaled
    // 300px thumbnail looks worse than a small, sharp product.
    withoutEnlargement: false,
    kernel: 'lanczos3' as const,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  };

  // Two stages, handed off as raw pixels rather than an encoded image. The cut
  // out subject used to be written to PNG purely so it could be decoded again
  // for the resize, which cost more than every other step here combined and
  // which nothing in between ever looked at.
  //
  // They stay two stages, though, because sharp queues operations into a fixed
  // pipeline instead of running them in the order written: fold the resize into
  // the same chain as the `extract` and the crop is applied *after* the resize,
  // so the output is a crop-sized thumbnail of a full-frame enlargement.
  // Materialising between them is what pins the order down.
  //
  // `trim` and `extract` can both fail — on an image that is entirely one
  // colour, or on a degenerate crop — so the fallback keeps the untouched
  // working image rather than losing the product.
  let cut: { data: Buffer; info: { width: number; height: number; channels: 1 | 2 | 3 | 4 } };
  try {
    cut = await subject.raw().toBuffer({ resolveWithObject: true });
  } catch {
    cut = await fromWork().raw().toBuffer({ resolveWithObject: true });
    backgroundRemoved = false;
    overlayRemoved = false;
    subjectWidth = workWidth;
  }

  const resized = await sharp(cut.data, {
    raw: { width: cut.info.width, height: cut.info.height, channels: cut.info.channels },
  })
    .resize(innerWidth, innerHeight, fit)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const productWidth = resized.info.width;
  const productHeight = resized.info.height;
  const left = Math.round((options.width - productWidth) / 2);
  const top = Math.round((options.height - productHeight) / 2);

  const silhouette = silhouetteMask;
  const upscaled = productWidth > Math.min(subjectWidth, sourceWidth);

  // --- compose ------------------------------------------------------------
  const layers: sharp.OverlayOptions[] = [];

  if (options.dropShadow && backgroundRemoved && options.background !== 'transparent') {
    const shadow = buildContactShadow(silhouette, productWidth, productHeight);
    if (shadow) {
      layers.push({
        input: shadow.buffer,
        left: Math.max(0, left - shadow.pad),
        top: Math.max(0, top - shadow.pad),
      });
    }
  }

  layers.push({
    input: resized.data,
    raw: {
      width: resized.info.width,
      height: resized.info.height,
      channels: resized.info.channels,
    },
    left,
    top,
  });

  if (input.aiBadge) {
    layers.push({
      input: buildAiBadge(options.width, options.height),
      left: 0,
      top: 0,
    });
  }

  let canvas = sharp(await createCanvas(options));
  canvas = canvas.composite(layers);

  // --- encode -------------------------------------------------------------
  const transparent = options.background === 'transparent';
  const format: OutputFormat = transparent && options.format === 'jpeg' ? 'png' : options.format;

  let output: sharp.Sharp;
  if (format === 'png') {
    output = canvas.png({ compressionLevel: 9, palette: false });
  } else if (format === 'webp') {
    output = canvas.webp({ quality: options.quality, effort: 4 });
  } else {
    output = canvas
      .flatten({ background: backgroundColour(options.background) })
      .jpeg({
        quality: options.quality,
        mozjpeg: env().JPEG_COMPRESSION === 'compact',
        // 4:4:4 regardless of encoder: chroma subsampling is what smears the
        // coloured edge of a product against a white backdrop, and that edge is
        // the whole subject here.
        chromaSubsampling: '4:4:4',
      });
  }

  const finalBuffer = await output.toBuffer();

  return {
    buffer: finalBuffer,
    width: options.width,
    height: options.height,
    bytes: finalBuffer.byteLength,
    mimeType: MIME[format],
    metrics: {
      sourceWidth,
      sourceHeight,
      borderVariance: border.variance,
      foregroundRatio,
      maskConfidence,
      detail,
      backgroundRemoved,
      overlayRemoved,
      upscaled,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * How large the working copy needs to be.
 *
 * The output is a fixed size, so past a point extra source pixels are decoded,
 * masked, cropped and then thrown away by the final resize. How far past that
 * point depends on the subject: one filling a quarter of the frame needs four
 * times the pixels of one filling all of it, because only its own area survives
 * the crop.
 *
 * The segmentation bounds say exactly what that fraction is, so this asks for
 * the smallest source that still lands the *subject* at full output resolution,
 * with a little headroom. The ceiling is twice the output edge: beyond that the
 * subject is a stamp in the corner of a huge photo, and a slight upscale costs
 * far less than decoding a 60-megapixel frame to keep it.
 */
export function chooseWorkingEdge(innerEdge: number, mask: MaskResult | null): number {
  const ceiling = innerEdge * 2;
  if (!mask?.bounds) return ceiling;

  const fraction = Math.max(
    mask.bounds.width / mask.width,
    mask.bounds.height / mask.height,
    0.05,
  );
  const needed = Math.ceil((innerEdge / fraction) * 1.05);
  return Math.max(innerEdge, Math.min(needed, ceiling));
}

/** Map a rectangle measured on the analysis image onto the working image. */
function scaleBounds(
  bounds: { left: number; top: number; width: number; height: number },
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): { left: number; top: number; width: number; height: number } {
  const scaleX = toWidth / fromWidth;
  const scaleY = toHeight / fromHeight;
  const left = Math.max(0, Math.floor(bounds.left * scaleX));
  const top = Math.max(0, Math.floor(bounds.top * scaleY));
  // Round outward so a feathered edge is never clipped, then clamp to the frame.
  const width = Math.min(toWidth - left, Math.max(1, Math.ceil(bounds.width * scaleX) + 1));
  const height = Math.min(toHeight - top, Math.max(1, Math.ceil(bounds.height * scaleY) + 1));
  return { left, top, width, height };
}

async function downscaleToRaw(buffer: Buffer, maxEdge = ANALYSIS_MAX_EDGE): Promise<{
  data: Buffer;
  info: { width: number; height: number; channels: number };
}> {
  const result = await sharp(buffer, decodeOptions())
    .rotate()
    .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true })
    // Flatten onto white so a transparent source does not read as black pixels.
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: result.data,
    info: {
      width: result.info.width,
      height: result.info.height,
      channels: result.info.channels,
    },
  };
}

/** Mean absolute deviation of luminance — a cheap stand-in for "has detail". */
function measureDetail(
  data: Buffer | Uint8Array,
  width: number,
  height: number,
  channels: number,
): number {
  const total = width * height;
  if (total === 0) return 0;

  // Sample rather than scanning every pixel; the metric only needs to be
  // directionally right.
  const step = Math.max(1, Math.floor(total / 20_000));
  let sum = 0;
  let count = 0;
  const values: number[] = [];

  for (let i = 0; i < total; i += step) {
    const index = i * channels;
    const luma =
      0.299 * (data[index] ?? 0) + 0.587 * (data[index + 1] ?? 0) + 0.114 * (data[index + 2] ?? 0);
    values.push(luma);
    sum += luma;
    count += 1;
  }

  if (count === 0) return 0;
  const mean = sum / count;
  let deviation = 0;
  for (const value of values) deviation += Math.abs(value - mean);
  return deviation / count;
}

/**
 * A PNG can carry an alpha channel that is fully opaque. Only treat the source
 * as a cutout when a meaningful share of pixels is actually transparent.
 */
async function hasMeaningfulAlpha(buffer: Buffer): Promise<boolean> {
  try {
    const { data, info } = await sharp(buffer, decodeOptions())
      .rotate()
      .resize(160, 160, { fit: 'inside' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = info.width * info.height;
    if (pixels === 0) return false;

    let transparent = 0;
    for (let i = 0; i < pixels; i += 1) {
      if ((data[i * info.channels + 3] ?? 255) < 200) transparent += 1;
    }
    return transparent / pixels > 0.05;
  } catch {
    return false;
  }
}

function backgroundColour(style: BackgroundStyle): sharp.Color {
  switch (style) {
    case 'transparent':
      return { r: 255, g: 255, b: 255, alpha: 0 };
    case 'light-gray':
      return { r: 244, g: 245, b: 247, alpha: 1 };
    case 'studio':
      return { r: 250, g: 250, b: 251, alpha: 1 };
    case 'white':
    default:
      return { r: 255, g: 255, b: 255, alpha: 1 };
  }
}

async function createCanvas(options: RenderOptions): Promise<Buffer> {
  if (options.background === 'studio') {
    // A soft vertical falloff reads as a seamless sweep without looking grey.
    const svg = `<svg width="${options.width}" height="${options.height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="g" cx="50%" cy="38%" r="78%">
          <stop offset="0%" stop-color="#ffffff"/>
          <stop offset="65%" stop-color="#fbfbfc"/>
          <stop offset="100%" stop-color="#eeeff2"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  return sharp({
    create: {
      width: options.width,
      height: options.height,
      channels: 4,
      background: backgroundColour(options.background),
    },
  })
    .png()
    .toBuffer();
}

/**
 * Build a soft contact shadow from the product's own silhouette: take the
 * alpha channel, squash it vertically so it reads as a shadow on a surface,
 * blur it, and tint it dark.
 */
function buildContactShadow(
  silhouette: MaskResult | null,
  width: number,
  height: number,
): { buffer: Buffer; pad: number } | null {
  try {
    const footprint = measureFootprint(silhouette, width);
    if (!footprint) return null;

    const pad = Math.max(8, Math.round(Math.max(width, height) * 0.06));
    const canvasWidth = width + pad * 2;
    const canvasHeight = height + pad * 2;

    // A little wider than the base so the product looks seated rather than
    // balanced, and shallow enough to read as ground rather than as an object.
    const rx = Math.max(6, Math.round(footprint.width * 0.75));
    const ry = Math.max(3, Math.round(Math.min(height * 0.03, rx * 0.3)));
    const cx = pad + footprint.centerX;
    // Straddle the bottom edge, most of it below: centred any higher and the
    // product simply covers its own shadow.
    const cy = pad + height + Math.round(ry * 0.25);
    // A radial gradient rather than a blurred silhouette: the falloff is
    // explicit, so it stays soft at any output size instead of depending on a
    // blur radius that must be re-tuned per resolution.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">
      <defs>
        <radialGradient id="s" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#0b0d12" stop-opacity="0.32"/>
          <stop offset="45%" stop-color="#0b0d12" stop-opacity="0.18"/>
          <stop offset="100%" stop-color="#0b0d12" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#s)"/>
    </svg>`;

    // sharp composites an SVG buffer directly, so the gradient is rasterised
    // at the output resolution rather than scaled from a bitmap.
    return { buffer: Buffer.from(svg), pad };
  } catch {
    // A missing shadow is cosmetic; never fail a render over it.
    return null;
  }
}

/**
 * Horizontal extent of the product's base, taken from the segmentation mask.
 *
 * The mask is used rather than the rendered product's alpha channel because a
 * sharp round-trip through an encoded buffer silently returned a fully opaque
 * alpha, which measured every product as full width and turned the shadow into
 * a grey bar across the frame. The mask is already computed, exact, and needs
 * no decoding.
 */
function measureFootprint(
  silhouette: MaskResult | null,
  width: number,
): { centerX: number; width: number } | null {
  if (!silhouette?.bounds) return null;
  const { mask, bounds } = silhouette;

  // The bottom eighth of the product's bounding box is what rests on a surface.
  const fromRow = Math.floor(bounds.top + bounds.height * 0.875);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = -1;

  for (let y = fromRow; y < bounds.top + bounds.height; y += 1) {
    const row = y * silhouette.width;
    for (let x = bounds.left; x < bounds.left + bounds.width; x += 1) {
      if (mask[row + x] === 255) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }

  if (maxX < minX) return null;

  // Mask coordinates are relative to the analysis image; the product was
  // trimmed to `bounds`, so normalise into the rendered product's width.
  const scale = width / bounds.width;
  return {
    centerX: ((minX + maxX) / 2 - bounds.left) * scale,
    width: Math.min((maxX - minX + 1) * scale, width * 0.9),
  };
}

/**
 * Corner badge for Workflow B output. Disclosure matters: a buyer looking at a
 * catalog should be able to tell a rendering from a photograph.
 */
function buildAiBadge(width: number, height: number): Buffer {
  const fontSize = Math.max(11, Math.round(width * 0.022));
  const padX = Math.round(fontSize * 0.7);
  const padY = Math.round(fontSize * 0.45);
  const boxWidth = Math.round(fontSize * 7.6);
  const boxHeight = fontSize + padY * 2;
  const margin = Math.round(width * 0.02);

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(${width - boxWidth - margin}, ${height - boxHeight - margin})">
      <rect width="${boxWidth}" height="${boxHeight}" rx="${Math.round(boxHeight / 2)}"
            fill="#0f172a" fill-opacity="0.72"/>
      <text x="${padX}" y="${padY + fontSize * 0.8}" font-family="Helvetica, Arial, sans-serif"
            font-size="${fontSize}" font-weight="600" fill="#ffffff" letter-spacing="0.5">AI GENERATED</text>
    </g>
  </svg>`;

  return Buffer.from(svg);
}
