/**
 * Background removal without a third-party API.
 *
 * Catalog and marketplace photography is overwhelmingly shot on a plain
 * backdrop, which makes a border-seeded flood fill both cheap and accurate for
 * the common case: start from the frame edges, absorb every pixel that is
 * close in colour to its neighbour, and treat what's left as the product.
 *
 * This is deliberately conservative. When the fill would consume most of the
 * image, or the borders are visually busy, we report low confidence and the
 * caller keeps the original background rather than punching a hole through the
 * product. A hosted matting model (remove.bg) is available for the hard cases.
 */

export interface MaskResult {
  /** One byte per pixel: 255 = foreground, 0 = background. */
  mask: Uint8Array;
  width: number;
  height: number;
  /** 0..1 — how much to trust this mask. */
  confidence: number;
  /** Detected backdrop colour, useful for compositing decisions. */
  backgroundColor: { r: number; g: number; b: number };
  foregroundRatio: number;
  /** Tight bounding box of the foreground, or null when nothing was found. */
  bounds: { left: number; top: number; width: number; height: number } | null;
}

export interface MaskOptions {
  /** Max per-channel distance from the seed colour, 0-255. */
  tolerance?: number;
  channels: number;
}

/** Squared Euclidean distance in RGB, avoiding a sqrt in the inner loop. */
function colourDistanceSq(
  data: Uint8Array | Buffer,
  a: number,
  b: number,
  channels: number,
): number {
  const dr = (data[a] ?? 0) - (data[b] ?? 0);
  const dg = (data[a + 1] ?? 0) - (data[b + 1] ?? 0);
  const db = (data[a + 2] ?? 0) - (data[b + 2] ?? 0);
  return dr * dr + dg * dg + db * db;
}

/**
 * Sample the frame border to work out the backdrop colour and how uniform it
 * is. A high variance means the photo is a lifestyle shot, not a cutout, and
 * the flood fill should not be trusted.
 */
export function analyseBorder(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
): { r: number; g: number; b: number; variance: number } {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  const samples: number[] = [];

  const push = (x: number, y: number) => {
    const index = (y * width + x) * channels;
    const r = data[index] ?? 0;
    const g = data[index + 1] ?? 0;
    const b = data[index + 2] ?? 0;
    sumR += r;
    sumG += g;
    sumB += b;
    samples.push(index);
    count += 1;
  };

  // Walk the perimeter with a stride so very large images stay cheap.
  const strideX = Math.max(1, Math.floor(width / 100));
  const strideY = Math.max(1, Math.floor(height / 100));
  for (let x = 0; x < width; x += strideX) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += strideY) {
    push(0, y);
    push(width - 1, y);
  }

  if (count === 0) return { r: 255, g: 255, b: 255, variance: 0 };

  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;

  let variance = 0;
  for (const index of samples) {
    const dr = (data[index] ?? 0) - meanR;
    const dg = (data[index + 1] ?? 0) - meanG;
    const db = (data[index + 2] ?? 0) - meanB;
    variance += (dr * dr + dg * dg + db * db) / 3;
  }
  variance /= count;

  return { r: Math.round(meanR), g: Math.round(meanG), b: Math.round(meanB), variance };
}

/**
 * Border-seeded flood fill. Operates on raw pixel data so it can be unit
 * tested without sharp; callers hand in a decoded buffer.
 */
export function buildForegroundMask(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  options: MaskOptions,
): MaskResult {
  const { channels } = options;
  const total = width * height;
  const mask = new Uint8Array(total).fill(255);
  const border = analyseBorder(data, width, height, channels);

  // A busy border means there is no backdrop to remove.
  const borderIsUniform = border.variance < 900;
  const tolerance = options.tolerance ?? (border.variance < 120 ? 26 : 38);
  const toleranceSq = tolerance * tolerance * 3;

  // Iterative fill with an explicit stack; recursion would blow up on 4K images.
  const stack = new Int32Array(total);
  let stackSize = 0;
  const visited = new Uint8Array(total);

  const seedColour = { r: border.r, g: border.g, b: border.b };

  const matchesBackground = (pixel: number): boolean => {
    const index = pixel * channels;
    const dr = (data[index] ?? 0) - seedColour.r;
    const dg = (data[index + 1] ?? 0) - seedColour.g;
    const db = (data[index + 2] ?? 0) - seedColour.b;
    return dr * dr + dg * dg + db * db <= toleranceSq;
  };

  const pushSeed = (pixel: number) => {
    if (visited[pixel]) return;
    if (!matchesBackground(pixel)) return;
    visited[pixel] = 1;
    stack[stackSize] = pixel;
    stackSize += 1;
  };

  for (let x = 0; x < width; x += 1) {
    pushSeed(x);
    pushSeed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    pushSeed(y * width);
    pushSeed(y * width + width - 1);
  }

  // Local tolerance keeps gradient backdrops (very common in studio shots)
  // from stopping the fill halfway.
  const localToleranceSq = Math.max(toleranceSq * 0.45, 300);
  let backgroundCount = 0;

  while (stackSize > 0) {
    stackSize -= 1;
    const pixel = stack[stackSize]!;
    mask[pixel] = 0;
    backgroundCount += 1;

    const x = pixel % width;
    const y = (pixel / width) | 0;
    const base = pixel * channels;

    const consider = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      const neighbour = ny * width + nx;
      if (visited[neighbour]) return;
      const neighbourIndex = neighbour * channels;
      const closeToSeed = matchesBackground(neighbour);
      const closeToNeighbour =
        colourDistanceSq(data, base, neighbourIndex, channels) <= localToleranceSq;
      if (!closeToSeed && !closeToNeighbour) return;
      visited[neighbour] = 1;
      stack[stackSize] = neighbour;
      stackSize += 1;
    };

    consider(x - 1, y);
    consider(x + 1, y);
    consider(x, y - 1);
    consider(x, y + 1);
  }

  const foregroundRatio = 1 - backgroundCount / total;

  // Bounding box of what survived.
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (mask[row + x] === 255) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const bounds =
    maxX >= minX && maxY >= minY
      ? { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null;

  return {
    mask,
    width,
    height,
    confidence: scoreMask({ foregroundRatio, borderIsUniform, variance: border.variance, bounds, width, height }),
    backgroundColor: seedColour,
    foregroundRatio,
    bounds,
  };
}

function scoreMask(input: {
  foregroundRatio: number;
  borderIsUniform: boolean;
  variance: number;
  bounds: MaskResult['bounds'];
  width: number;
  height: number;
}): number {
  if (!input.bounds) return 0;
  if (!input.borderIsUniform) return 0.15;

  // Nothing removed means there was no backdrop; nearly everything removed
  // means the fill leaked through the product.
  if (input.foregroundRatio > 0.97) return 0.1;
  if (input.foregroundRatio < 0.02) return 0.05;

  let score = 0.5;
  // A product typically occupies 10-80% of a catalog frame.
  if (input.foregroundRatio >= 0.08 && input.foregroundRatio <= 0.85) score += 0.3;
  if (input.variance < 120) score += 0.2;
  else if (input.variance < 400) score += 0.1;

  // A foreground touching all four edges suggests the fill failed to enclose it.
  const touchesLeft = input.bounds.left === 0;
  const touchesTop = input.bounds.top === 0;
  const touchesRight = input.bounds.left + input.bounds.width >= input.width;
  const touchesBottom = input.bounds.top + input.bounds.height >= input.height;
  const touching = [touchesLeft, touchesTop, touchesRight, touchesBottom].filter(Boolean).length;
  if (touching >= 3) score -= 0.25;

  return Math.max(0, Math.min(1, score));
}

/**
 * Soften mask edges so a cutout does not look like it was cut with scissors.
 * A small box blur over the binary mask produces usable anti-aliasing.
 */
export function featherMask(mask: Uint8Array, width: number, height: number, radius = 1): Uint8Array {
  if (radius <= 0) return mask;
  const output = new Uint8Array(mask.length);
  const window = (radius * 2 + 1) ** 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          // Treat out-of-frame as background so edges fade outward.
          continue;
        }
        const row = ny * width;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          sum += mask[row + nx] ?? 0;
        }
      }
      output[y * width + x] = Math.round(sum / window);
    }
  }

  return output;
}
