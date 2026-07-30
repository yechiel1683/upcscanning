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
  /** Extent of everything in the frame carrying an edge. See measureInkBounds. */
  inkBounds: { left: number; top: number; width: number; height: number } | null;
  /**
   * The fill absorbed part of the subject.
   *
   * A verdict about the photograph, kept separate from `confidence` because it
   * has to survive being re-segmented: erasing a promotional panel legitimately
   * shrinks the mask, so the second pass cannot re-derive this for itself and
   * inherits the first pass's answer instead.
   */
  fillLeaked: boolean;
}

export interface MaskOptions {
  /** Max per-channel distance from the seed colour, 0-255. */
  tolerance?: number;
  channels: number;
  /**
   * Ink bounds measured on the *original* frame.
   *
   * Supplied when segmenting a doctored copy — the overlay pass paints its
   * panels out with an estimated backdrop colour, which leaves a rectangle of
   * edges where the panel was. Measuring on that copy would report structure
   * the photograph does not have, and the leak check would read a correct
   * cutout as a failed one.
   */
  inkBounds?: { left: number; top: number; width: number; height: number } | null;
}

/** Squared Euclidean distance in RGB, avoiding a sqrt in the inner loop. */
function colourDistanceSq(data: Uint8Array | Buffer, a: number, b: number): number {
  const dr = (data[a] ?? 0) - (data[b] ?? 0);
  const dg = (data[a + 1] ?? 0) - (data[b + 1] ?? 0);
  const db = (data[a + 2] ?? 0) - (data[b + 2] ?? 0);
  return dr * dr + dg * dg + db * db;
}

/**
 * Sample the frame border to work out the backdrop colour and how uniform it
 * is. A high variance means the photo is a lifestyle shot, not a cutout, and
 * the flood fill should not be trusted.
 *
 * The colour is a per-channel **median**, not a mean, and the difference
 * matters as soon as the tolerance is tight. Listing images routinely have
 * something running off the edge of the frame — a promotional banner, a prop,
 * a second pack — and a mean is dragged towards it: one blue panel along the
 * left edge moves an estimate of white thirty levels towards blue. The fill
 * then seeds on a colour that appears nowhere in the actual backdrop, and with
 * little tolerance to spare it cannot start at all. A median ignores anything
 * short of half the border.
 *
 * The variance is still measured about that colour, so a border with a banner
 * in it correctly reports as less uniform — which is the signal the overlay
 * pass exists to act on.
 */
export function analyseBorder(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
): { r: number; g: number; b: number; variance: number } {
  let count = 0;
  const samples: number[] = [];
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  const push = (x: number, y: number) => {
    const index = (y * width + x) * channels;
    reds.push(data[index] ?? 0);
    greens.push(data[index + 1] ?? 0);
    blues.push(data[index + 2] ?? 0);
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

  const median = (values: number[]): number => {
    values.sort((a, b) => a - b);
    const middle = values.length >> 1;
    return values.length % 2 === 0
      ? (values[middle - 1]! + values[middle]!) / 2
      : values[middle]!;
  };

  const centreR = median(reds);
  const centreG = median(greens);
  const centreB = median(blues);

  let variance = 0;
  for (const index of samples) {
    const dr = (data[index] ?? 0) - centreR;
    const dg = (data[index + 1] ?? 0) - centreG;
    const db = (data[index + 2] ?? 0) - centreB;
    variance += (dr * dr + dg * dg + db * db) / 3;
  }
  variance /= count;

  return {
    r: Math.round(centreR),
    g: Math.round(centreG),
    b: Math.round(centreB),
    variance,
  };
}

/**
 * The extent of everything in the frame that has an edge in it.
 *
 * This exists to catch the one failure a colour-based fill cannot catch by
 * itself: a white product on a white backdrop. The fill is not wrong to absorb
 * it — the pixels really are the backdrop's colour, to within any tolerance
 * worth using — so the mask comes back describing a bottle's *label* and
 * nothing else, and every confidence signal computed from that mask looks
 * healthy, because a label is a perfectly plausible small product.
 *
 * Structure is what survives when colour does not. A white bottle still has a
 * silhouette, a shoulder, a shadow: places where neighbouring pixels differ,
 * however slightly. Measuring where that structure reaches gives an independent
 * answer to "how big is the thing in this picture", which can then be compared
 * with what the fill decided to keep.
 *
 * Measured on a box-averaged copy at a quarter scale, which is the difference
 * between this working and not. Grain is what an edge detector sees most of: a
 * JPEG's noise puts a small edge on nearly every pixel, so no per-pixel
 * threshold and no minimum count per row can separate grain from structure —
 * grain is present on every row. Averaging sixteen pixels into one divides the
 * noise by four and leaves a product's outline untouched. It is also cheaper
 * than scanning at full size.
 */
const INK_SCALE = 4;

export function measureInkBounds(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  minEdge = 5,
): { left: number; top: number; width: number; height: number } | null {
  if (width < INK_SCALE * 2 || height < INK_SCALE * 2) return null;

  const w = Math.floor(width / INK_SCALE);
  const h = Math.floor(height / INK_SCALE);
  const small = new Int32Array(w * h * 3);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < INK_SCALE; dy += 1) {
        const row = (y * INK_SCALE + dy) * width;
        for (let dx = 0; dx < INK_SCALE; dx += 1) {
          const index = (row + x * INK_SCALE + dx) * channels;
          r += data[index] ?? 0;
          g += data[index + 1] ?? 0;
          b += data[index + 2] ?? 0;
        }
      }
      const out = (y * w + x) * 3;
      const n = INK_SCALE * INK_SCALE;
      small[out] = r / n;
      small[out + 1] = g / n;
      small[out + 2] = b / n;
    }
  }

  const rowCounts = new Int32Array(h);
  const columnCounts = new Int32Array(w);

  const differs = (a: number, b: number): boolean =>
    Math.max(
      Math.abs(small[a]! - small[b]!),
      Math.abs(small[a + 1]! - small[b + 1]!),
      Math.abs(small[a + 2]! - small[b + 2]!),
    ) >= minEdge;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const pixel = y * w + x;
      const base = pixel * 3;
      const right = x + 1 < w && differs(base, (pixel + 1) * 3);
      const down = y + 1 < h && differs(base, (pixel + w) * 3);
      if (right || down) {
        rowCounts[y] = (rowCounts[y] ?? 0) + 1;
        columnCounts[x] = (columnCounts[x] ?? 0) + 1;
      }
    }
  }

  const MIN_PER_LINE = 2;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y += 1) {
    if (rowCounts[y]! < MIN_PER_LINE) continue;
    if (top < 0) top = y;
    bottom = y;
  }
  let left = -1;
  let right = -1;
  for (let x = 0; x < w; x += 1) {
    if (columnCounts[x]! < MIN_PER_LINE) continue;
    if (left < 0) left = x;
    right = x;
  }
  if (top < 0 || left < 0) return null;

  // Back to full-resolution coordinates, rounded outward.
  const scaledLeft = left * INK_SCALE;
  const scaledTop = top * INK_SCALE;
  return {
    left: scaledLeft,
    top: scaledTop,
    width: Math.min(width - scaledLeft, (right - left + 2) * INK_SCALE),
    height: Math.min(height - scaledTop, (bottom - top + 2) * INK_SCALE),
  };
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
  /**
   * Deliberately tight.
   *
   * This was 26 — anything within 26 levels of the backdrop counted as
   * backdrop — which is generous enough to swallow a product. A grey bottle
   * twenty levels off white is not a subtle case; it is an ordinary one, and it
   * was being absorbed before the fill had to creep anywhere.
   *
   * Scored against known silhouettes across nine fixtures, mean intersection
   * over union runs 0.68 at a tolerance of 26 and 0.86 at 8, and the
   * well-separated products — dark, blue, red, mid-grey — sit at 0.97 either
   * way. So the generosity bought nothing except the ability to destroy pale
   * products. A backdrop uniform enough to flood-fill needs very little
   * latitude; one that is not uniform gets more, and is separately distrusted.
   */
  const tolerance = options.tolerance ?? (border.variance < 120 ? 8 : 18);
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
  // from stopping the fill halfway: each step only has to resemble the step
  // before it, so a slow sweep from white to grey is followed all the way.
  const localToleranceSq = Math.max(toleranceSq * 0.45, 300);

  // ...but only while the fill stays recognisably the backdrop.
  //
  // Step-to-step similarity alone is a licence to walk anywhere, one small step
  // at a time, and a photographed edge is exactly the ramp it needs. Any image
  // that has been JPEG-compressed or resized — which is every image an image
  // search returns — has edges several pixels wide, so a mid-grey bottle
  // seventy levels off a white backdrop is crossed in eight steps of nine. The
  // fill then empties the product from the inside and leaves its logo, and
  // every mask-shaped signal still looks healthy because what remains is small,
  // compact and plausible.
  //
  // Measured on the fixture matrix, an ordinary grey bottle came back with 0.3%
  // of its own bounding box filled. That is the bug behind every washed-out
  // render: not a bad cutout, a deleted product.
  //
  // Bounding the total drift keeps the property the creep was added for — a
  // studio sweep stays near the backdrop's own colour throughout — while
  // refusing the march into something genuinely a different colour.
  const driftToleranceSq = (tolerance + 8) ** 2 * 3;
  const withinDrift = (pixel: number): boolean => {
    const index = pixel * channels;
    const dr = (data[index] ?? 0) - seedColour.r;
    const dg = (data[index + 1] ?? 0) - seedColour.g;
    const db = (data[index + 2] ?? 0) - seedColour.b;
    return dr * dr + dg * dg + db * db <= driftToleranceSq;
  };

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
        colourDistanceSq(data, base, neighbourIndex) <= localToleranceSq &&
        withinDrift(neighbour);
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

  const inkBounds =
    options.inkBounds !== undefined
      ? options.inkBounds
      : measureInkBounds(data, width, height, channels);

  const fillLeaked = detectLeak({
    mask,
    width,
    height,
    bounds,
    inkBounds,
    foregroundCount: total - backgroundCount,
  });

  return {
    mask,
    width,
    height,
    confidence: scoreMask({
      foregroundRatio,
      borderIsUniform,
      variance: border.variance,
      bounds,
      fillLeaked,
      width,
      height,
    }),
    backgroundColor: seedColour,
    foregroundRatio,
    bounds,
    inkBounds,
    fillLeaked,
  };
}

/** Above this share of its own bounding box, a mask is solid enough to trust. */
const OBVIOUSLY_SOLID = 0.8;

/** Below this, the shapes the fill kept are ragged rather than whole. */
const SHAPES_ARE_WHOLE = 0.75;

/**
 * Did the fill eat the product?
 *
 * There are two ways it happens and they look nothing alike, so both are asked
 * about. Either way the answer is the same: this image cannot be segmented by
 * colour, so keep the original backdrop. A real photograph with its own
 * background beats a cutout with the product removed.
 *
 *  1. **Extent.** The fill kept a compact blob — a bottle's label — while the
 *     picture still has structure far outside it. Every mask-shaped signal
 *     looks healthy here, because a label is a perfectly plausible product.
 *
 *  2. **Coherence.** The fill invaded the subject but did not finish, leaving
 *     islands scattered across its full extent: a logo here, a dark graphic
 *     there. The bounding box is then correct and only the *contents* are
 *     wrong, which is what defeats the extent check. Rendered, this is the
 *     washed-out ghost — high-contrast fragments floating where a product was.
 *
 * The second test costs a pass over the mask, so it runs only when density
 * already looks wrong. On the fixtures every genuine product silhouette came
 * back as a single component holding all of its foreground, against 0.40 in
 * three pieces for a ghost, so the margin is wide and the fast path is the
 * common one.
 */
function detectLeak(input: {
  mask: Uint8Array;
  width: number;
  height: number;
  bounds: MaskResult['bounds'];
  inkBounds: MaskResult['bounds'];
  foregroundCount: number;
}): boolean {
  const { bounds, inkBounds } = input;
  if (!bounds) return false;

  if (inkBounds) {
    const inkArea = inkBounds.width * inkBounds.height;
    if (inkArea > 0 && (bounds.width * bounds.height) / inkArea < 0.5) return true;

    // Density against the whole ink rectangle was tried here and removed. It
    // measures segmentation quality remarkably well on a single subject — it
    // tracked true intersection-over-union almost one to one across the
    // fixtures — but a rectangle drawn around *two* subjects also contains the
    // backdrop between them, so every listing image with a banner beside the
    // product read as a leak. The per-shape version below keeps the accuracy and
    // loses the blind spot.
  }

  const boxArea = bounds.width * bounds.height;
  if (boxArea <= 0) return false;
  // Already one solid block filling its own box: nothing to investigate, and
  // this is the common case, so it skips the pass below.
  if (input.foregroundCount / boxArea >= OBVIOUSLY_SOLID) return false;

  return (
    shapeSolidity(input.mask, input.width, input.height, input.foregroundCount) < SHAPES_ARE_WHOLE
  );
}

/**
 * How completely the shapes the fill kept fill their own outlines.
 *
 * Each connected region is measured against its *own* bounding box, and the
 * results pooled by area. That last detail is the point: judging the whole mask
 * against one rectangle spanning everything counts the backdrop between two
 * subjects as a hole, so a product standing beside a promotional banner scores
 * as badly as a product with bites out of it. Per shape, a banner is a solid
 * rectangle, a bottle is a solid bottle, and the gap between them is nobody's
 * hole.
 *
 * What this does catch is the shape that is genuinely ragged — the pale product
 * the fill invaded and half-emptied, whose outline is right and whose interior
 * is missing. On the fixtures that lands near 0.6 against 0.9 for a clean
 * silhouette, and it tracks true intersection-over-union closely enough to use
 * as a stand-in for it on images where no ground truth exists.
 *
 * Regions below a percent of the foreground are ignored as speckle.
 */
function shapeSolidity(
  mask: Uint8Array,
  width: number,
  height: number,
  foregroundCount: number,
): number {
  if (foregroundCount <= 0) return 0;
  const total = width * height;
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  const minArea = foregroundCount * 0.01;

  let areaSum = 0;
  let boxSum = 0;

  for (let start = 0; start < total; start += 1) {
    if (mask[start] !== 255 || seen[start]) continue;

    let head = 0;
    let tail = 0;
    let area = 0;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;

    queue[tail] = start;
    tail += 1;
    seen[start] = 1;

    while (head < tail) {
      const pixel = queue[head]!;
      head += 1;
      area += 1;
      const x = pixel % width;
      const y = (pixel / width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const visit = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const neighbour = ny * width + nx;
        if (mask[neighbour] !== 255 || seen[neighbour]) return;
        seen[neighbour] = 1;
        queue[tail] = neighbour;
        tail += 1;
      };

      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }

    if (area < minArea) continue;
    areaSum += area;
    boxSum += (maxX - minX + 1) * (maxY - minY + 1);
  }

  return boxSum > 0 ? areaSum / boxSum : 0;
}

function scoreMask(input: {
  foregroundRatio: number;
  borderIsUniform: boolean;
  variance: number;
  bounds: MaskResult['bounds'];
  fillLeaked: boolean;
  width: number;
  height: number;
}): number {
  if (!input.bounds) return 0;
  if (!input.borderIsUniform) return 0.15;
  if (input.fillLeaked) return 0.2;

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
