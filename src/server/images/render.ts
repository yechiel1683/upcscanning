import sharp from 'sharp';

import type { BackgroundStyle, OutputFormat, RenderOptions } from '@/lib/types';
import {
  analyseBorder,
  buildForegroundMask,
  featherMask,
  type MaskResult,
} from './background';

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
}> {
  const image = sharp(buffer, { failOn: 'none' }).rotate();
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error('Image has no readable dimensions');

  const { data, info } = await downscaleToRaw(buffer);
  const border = analyseBorder(data, info.width, info.height, info.channels);
  const mask = buildForegroundMask(data, info.width, info.height, { channels: info.channels });

  return {
    width,
    height,
    hasAlpha: Boolean(metadata.hasAlpha),
    borderVariance: border.variance,
    foregroundRatio: mask.foregroundRatio,
    maskConfidence: mask.confidence,
    detail: measureDetail(data, info.width, info.height, info.channels),
  };
}

export async function renderProductImage(input: RenderInput): Promise<RenderResult> {
  const { options } = input;

  const base = sharp(input.buffer, { failOn: 'none' }).rotate();
  const metadata = await base.metadata();
  const sourceWidth = metadata.width ?? 0;
  const sourceHeight = metadata.height ?? 0;
  if (!sourceWidth || !sourceHeight) throw new Error('Image has no readable dimensions');

  // --- analysis on a downscaled copy -------------------------------------
  const { data: smallData, info: smallInfo } = await downscaleToRaw(input.buffer);
  const border = analyseBorder(smallData, smallInfo.width, smallInfo.height, smallInfo.channels);
  const detail = measureDetail(smallData, smallInfo.width, smallInfo.height, smallInfo.channels);

  const alreadyTransparent = Boolean(metadata.hasAlpha) && (await hasMeaningfulAlpha(input.buffer));

  let subject = sharp(await base.toBuffer(), { failOn: 'none' });
  let backgroundRemoved = false;
  let foregroundRatio: number | undefined;
  let maskConfidence: number | undefined;
  let silhouette: MaskResult | null = null;

  if (alreadyTransparent) {
    // The source is already a cutout; trimming its alpha is enough.
    backgroundRemoved = true;
    subject = subject.trim({ threshold: 1 });
  } else if (options.removeBackground || options.background === 'transparent') {
    const mask = buildForegroundMask(smallData, smallInfo.width, smallInfo.height, {
      channels: smallInfo.channels,
    });
    foregroundRatio = mask.foregroundRatio;
    maskConfidence = mask.confidence;

    if (mask.confidence >= CUTOUT_CONFIDENCE_THRESHOLD && mask.bounds) {
      const feathered = featherMask(mask.mask, mask.width, mask.height, 1);
      const fullAlpha = await sharp(Buffer.from(feathered), {
        raw: { width: mask.width, height: mask.height, channels: 1 },
      })
        .resize(sourceWidth, sourceHeight, { fit: 'fill', kernel: 'cubic' })
        .toBuffer();

      subject = sharp(
        await sharp(await base.toBuffer(), { failOn: 'none' })
          .removeAlpha()
          .joinChannel(fullAlpha, {
            raw: { width: sourceWidth, height: sourceHeight, channels: 1 },
          })
          .png()
          .toBuffer(),
      ).trim({ threshold: 1 });
      backgroundRemoved = true;
      silhouette = mask;
    } else {
      // Not confident enough to cut out. If the backdrop is at least uniform we
      // can still trim the flat margins so framing stays consistent.
      if (border.variance < 400) {
        subject = subject.trim({ threshold: 12 });
      }
    }
  } else if (border.variance < 400) {
    subject = subject.trim({ threshold: 12 });
  }

  // `trim` can fail on an image that is entirely one colour; fall back to the
  // untrimmed original rather than losing the product.
  let subjectBuffer: Buffer;
  try {
    subjectBuffer = await subject.png().toBuffer();
  } catch {
    subjectBuffer = await sharp(input.buffer, { failOn: 'none' }).rotate().png().toBuffer();
    backgroundRemoved = false;
  }

  const trimmed = await sharp(subjectBuffer).metadata();
  if (!trimmed.width || !trimmed.height) {
    subjectBuffer = await sharp(input.buffer, { failOn: 'none' }).rotate().png().toBuffer();
  }

  // --- fit into the padded frame -----------------------------------------
  const padding = options.dropShadow ? Math.max(options.padding, 0.06) : options.padding;
  const innerWidth = Math.max(1, Math.round(options.width * (1 - padding * 2)));
  const innerHeight = Math.max(1, Math.round(options.height * (1 - padding * 2)));

  const resized = await sharp(subjectBuffer)
    .resize(innerWidth, innerHeight, {
      fit: 'inside',
      // Never blow a small source up beyond its native size — an upscaled
      // 300px thumbnail looks worse than a small, sharp product.
      withoutEnlargement: false,
      kernel: 'lanczos3',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .toBuffer({ resolveWithObject: true });

  const productWidth = resized.info.width;
  const productHeight = resized.info.height;
  const left = Math.round((options.width - productWidth) / 2);
  const top = Math.round((options.height - productHeight) / 2);

  const upscaled = productWidth > (trimmed.width ?? sourceWidth);

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

  layers.push({ input: resized.data, left, top });

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
      .jpeg({ quality: options.quality, mozjpeg: true, chromaSubsampling: '4:4:4' });
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
      upscaled,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function downscaleToRaw(buffer: Buffer): Promise<{
  data: Buffer;
  info: { width: number; height: number; channels: number };
}> {
  const result = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(ANALYSIS_MAX_EDGE, ANALYSIS_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
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
    const { data, info } = await sharp(buffer, { failOn: 'none' })
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
