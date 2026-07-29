/**
 * Promotional overlay detection.
 *
 * Retail listing images are not product photographs. Sellers composite
 * marketing furniture onto them — a coloured banner reading "All Day Fresh",
 * a "2-PACK" flash, a price starburst — and image search returns those just as
 * happily as it returns a clean pack shot. In a catalog they look wrong
 * immediately: every row carries somebody else's advertising, at a different
 * angle, in a different palette.
 *
 * The distinguishing property is that this furniture is *drawn*, not
 * photographed. So each connected region of the foreground is measured on two
 * axes:
 *
 *   rectangularity   area / bounding-box area — is the shape a filled rectangle?
 *   flatFillCoverage how much of the region is made of repeated exact colours?
 *
 * The second is the load-bearing signal, and it is specifically a measure of
 * *repetition*, not of smoothness. Drawn artwork is assembled from a few flat
 * fills, so a handful of exact colour values each account for a large share of
 * it: two blues and white text cover almost a whole banner. A photographed
 * surface is shaded, so no single exact value repeats — its colours creep
 * across a continuum and every one of them is rare.
 *
 * Two cheaper measures were tried first and both fail on real photographs.
 * Comparing each pixel with its neighbour calls a photograph flat everywhere,
 * because a smoothly shaded bottle changes by well under one level per pixel.
 * Counting how many coarsely quantised colours cover the region fails too: a
 * plain carton under even light spans only a few dozen levels, so bucketing
 * collapses it into as few colours as a banner. Only asking whether individual
 * colours *repeat* separates a fill from a gradient.
 *
 * Text inside a panel does not defeat this, because the glyphs are enclosed by
 * the panel and so join the same region, and the letterforms are themselves
 * flat fills.
 *
 * The result is used twice — to rank a clean photo above a composited one when
 * both exist, and to exclude the panel from the subject when only the
 * composited one does.
 */

export interface OverlayRegion {
  area: number;
  bounds: { left: number; top: number; width: number; height: number };
  rectangularity: number;
  flatFillCoverage: number;
}

export interface OverlayAnalysis {
  panels: OverlayRegion[];
  /** Share of the foreground that is drawn furniture rather than product. */
  panelShareOfForeground: number;
  /**
   * Foreground with the panels removed, or null when nothing was removed or
   * removing them would have taken the product with it.
   */
  productMask: Uint8Array | null;
  productBounds: { left: number; top: number; width: number; height: number } | null;
}

/** Ignore specks. A real banner is a substantial share of the frame. */
const MIN_PANEL_AREA_RATIO = 0.012;

/**
 * A photographed subject rarely fills its own bounding box this completely —
 * the mask follows the object's outline, and shadow softens the corners.
 */
const RECTANGULARITY_THRESHOLD = 0.86;

/**
 * Colour quantisation for the fill measure: 6 bits per channel. Fine enough
 * that a gradient never lands twice in the same bucket, coarse enough to
 * survive JPEG noise within a flat fill.
 */
const QUANT_BITS = 2;

/**
 * A colour covering this much of a region is a deliberate fill, not shading.
 *
 * Measured against the fixtures, this is where the two populations separate
 * cleanly. The most common single colour reaches 0.047 of a photographed
 * bottle and 0.062 of a plain carton — shading never concentrates — against
 * 0.468 and 0.450 for the two fills of a drawn banner. At 0.05 the carton
 * scores 0.68 and is misread as artwork; at 0.10 it scores zero while the
 * banner still scores 0.92. There is an order of magnitude of daylight here,
 * which is why the threshold is not delicate.
 */
const MIN_FILL_SHARE = 0.1;

/** Below this, the region is shaded like a photograph rather than drawn. */
const FLAT_FILL_THRESHOLD = 0.6;

/**
 * Never strip so much that the product goes with it. If what remains is a
 * fraction of what we started with, the "panel" was the product — a plain
 * carton photographed square-on can look drawn — and the whole analysis is
 * discarded rather than gambling with the one thing the user wanted.
 */
const MIN_PRODUCT_RETENTION = 0.35;

export function analyseOverlays(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  channels: number,
  mask: Uint8Array,
): OverlayAnalysis {
  const total = width * height;
  const empty: OverlayAnalysis = {
    panels: [],
    panelShareOfForeground: 0,
    productMask: null,
    productBounds: null,
  };
  if (total === 0) return empty;

  const labels = new Int32Array(total).fill(-1);
  const regions: Array<{ area: number; minX: number; minY: number; maxX: number; maxY: number }> =
    [];
  const queue = new Int32Array(total);

  // Label connected foreground regions (4-connectivity, iterative).
  for (let start = 0; start < total; start += 1) {
    if (mask[start] !== 255 || labels[start] !== -1) continue;

    const label = regions.length;
    const startX = start % width;
    const startY = (start / width) | 0;
    const region = { area: 0, minX: startX, minY: startY, maxX: startX, maxY: startY };
    regions.push(region);

    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    labels[start] = label;

    while (head < tail) {
      const pixel = queue[head]!;
      head += 1;
      region.area += 1;

      const x = pixel % width;
      const y = (pixel / width) | 0;
      if (x < region.minX) region.minX = x;
      if (x > region.maxX) region.maxX = x;
      if (y < region.minY) region.minY = y;
      if (y > region.maxY) region.maxY = y;

      const visit = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const neighbour = ny * width + nx;
        if (mask[neighbour] !== 255 || labels[neighbour] !== -1) return;
        labels[neighbour] = label;
        queue[tail] = neighbour;
        tail += 1;
      };

      visit(x - 1, y);
      visit(x + 1, y);
      visit(x, y - 1);
      visit(x, y + 1);
    }
  }

  const foregroundArea = regions.reduce((sum, r) => sum + r.area, 0);
  if (foregroundArea === 0) return empty;

  // Only regions big enough and rectangular enough are worth measuring texture
  // on, which keeps the second pass cheap.
  const minArea = total * MIN_PANEL_AREA_RATIO;
  // Sparse per-region colour counts: a photographic region has thousands of
  // distinct values, so a dense array would be mostly zeroes and far larger.
  const histograms = new Map<number, Map<number, number>>();

  regions.forEach((region, label) => {
    if (region.area < minArea) return;
    const boxArea = (region.maxX - region.minX + 1) * (region.maxY - region.minY + 1);
    if (boxArea <= 0) return;
    if (region.area / boxArea < RECTANGULARITY_THRESHOLD) return;
    histograms.set(label, new Map());
  });

  if (histograms.size > 0) {
    for (let pixel = 0; pixel < total; pixel += 1) {
      const histogram = histograms.get(labels[pixel]!);
      if (!histogram) continue;
      const base = pixel * channels;
      const key =
        (((data[base] ?? 0) >> QUANT_BITS) << 12) |
        (((data[base + 1] ?? 0) >> QUANT_BITS) << 6) |
        ((data[base + 2] ?? 0) >> QUANT_BITS);
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
  }

  const panels: OverlayRegion[] = [];
  const panelLabels = new Set<number>();
  let panelArea = 0;

  for (const [label, histogram] of histograms) {
    const region = regions[label]!;
    const flatFillCoverage = measureFlatFill(histogram, region.area);
    if (flatFillCoverage < FLAT_FILL_THRESHOLD) continue;

    const boxWidth = region.maxX - region.minX + 1;
    const boxHeight = region.maxY - region.minY + 1;
    panels.push({
      area: region.area,
      bounds: { left: region.minX, top: region.minY, width: boxWidth, height: boxHeight },
      rectangularity: region.area / (boxWidth * boxHeight),
      flatFillCoverage,
    });
    panelLabels.add(label);
    panelArea += region.area;
  }

  if (panels.length === 0) return empty;

  const panelShareOfForeground = panelArea / foregroundArea;
  const retained = foregroundArea - panelArea;

  // Everything that is left after stripping has to still be a product.
  if (retained / foregroundArea < MIN_PRODUCT_RETENTION) {
    return { panels, panelShareOfForeground, productMask: null, productBounds: null };
  }

  const productMask = new Uint8Array(mask);
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (panelLabels.has(labels[pixel]!)) productMask[pixel] = 0;
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (productMask[row + x] === 255) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const productBounds =
    maxX >= minX && maxY >= minY
      ? { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null;

  return { panels, panelShareOfForeground, productMask, productBounds };
}

/**
 * Paint the detected panels out with the backdrop colour.
 *
 * The caller then re-runs the ordinary analysis over the result, which is the
 * only way to get an honest answer out of it. Segmentation confidence is partly
 * a judgement about how uniform the frame border is, and a banner running to the
 * edge of the frame destroys that uniformity — so an image with furniture on it
 * is refused a cutout for the very reason the furniture needs removing. Erasing
 * the panels first turns it back into what it should have been: a product on a
 * plain backdrop.
 */
export function eraseOverlays(
  data: Uint8Array | Buffer,
  channels: number,
  foreground: Uint8Array,
  productMask: Uint8Array,
  colour: { r: number; g: number; b: number },
): Uint8Array {
  const cleaned = new Uint8Array(data);
  for (let pixel = 0; pixel < foreground.length; pixel += 1) {
    // Exactly the pixels the panels took: foreground before, background after.
    if (foreground[pixel] !== 255 || productMask[pixel] === 255) continue;
    const base = pixel * channels;
    cleaned[base] = colour.r;
    cleaned[base + 1] = colour.g;
    cleaned[base + 2] = colour.b;
  }
  return cleaned;
}

/**
 * How much of a region is covered by colours that repeat like a deliberate fill.
 *
 * Only colours holding at least MIN_FILL_SHARE of the region count. In drawn
 * artwork a few values clear that bar easily and together account for nearly
 * everything; in a photograph no single value comes close, so the total is
 * near zero. Anti-aliased glyph edges and compression ringing fall below the
 * bar and are simply not counted, which is the intended behaviour — they are
 * the parts of a panel that are not flat.
 */
function measureFlatFill(histogram: Map<number, number>, area: number): number {
  if (area <= 0) return 0;
  let covered = 0;
  for (const count of histogram.values()) {
    const share = count / area;
    if (share >= MIN_FILL_SHARE) covered += share;
  }
  return covered;
}
