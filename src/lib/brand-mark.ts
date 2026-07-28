/**
 * The single source of truth for the brand mark's geometry.
 *
 * Both the React component and the asset generator import this, so the favicon,
 * the app icon, the Apple touch icon, and the social card can never drift apart
 * from the logo in the header.
 *
 * All coordinates are in a 32×32 space and scaled at use.
 */

export const MARK_VIEWBOX = 32;

/**
 * Five bars in an uneven rhythm, with gaps narrower than the thinnest bar so it
 * reads as a barcode rather than a row of stripes. Five and not nine because
 * the mark has to survive a 16px favicon — sub-pixel bars disappear, and a
 * smudge is worse than a simplification.
 *
 * The left and right margins are identical (7.5), which is what stops it
 * looking accidental at small sizes.
 */
export const MARK_BARS: ReadonlyArray<{ x: number; w: number }> = [
  { x: 7.5, w: 2.0 },
  { x: 10.8, w: 3.4 },
  { x: 15.5, w: 1.6 },
  { x: 18.4, w: 2.8 },
  { x: 22.5, w: 2.0 },
];

export const MARK_BAR_Y = 9;
export const MARK_BAR_HEIGHT = 14;

/** Corner radius as a fraction of the tile, matching the iOS squircle ratio. */
export const MARK_RADIUS_RATIO = 0.22;

export interface MarkOptions {
  size: number;
  /** Inset the mark inside the tile, as a fraction of size. */
  padding?: number;
  /** Square tile, for platforms that apply their own mask. */
  square?: boolean;
  background?: string;
  foreground?: string;
}

/** Render the mark as a standalone SVG document. */
export function renderMarkSvg({
  size,
  padding = 0,
  square = false,
  background = '#000000',
  foreground = '#ffffff',
}: MarkOptions): string {
  const inset = size * padding;
  const inner = size - inset * 2;
  const scale = inner / MARK_VIEWBOX;
  const radius = square ? 0 : (size * MARK_RADIUS_RATIO).toFixed(2);

  const bars = MARK_BARS.map(
    (bar) =>
      `<rect x="${(bar.x * scale + inset).toFixed(3)}" y="${(MARK_BAR_Y * scale + inset).toFixed(3)}" ` +
      `width="${(bar.w * scale).toFixed(3)}" height="${(MARK_BAR_HEIGHT * scale).toFixed(3)}" ` +
      `rx="${Math.max(0.3, 0.5 * scale).toFixed(3)}" fill="${foreground}"/>`,
  ).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="${background}"/>
  ${bars}
</svg>`;
}
