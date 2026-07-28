import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import {
  MARK_BARS,
  MARK_BAR_HEIGHT,
  MARK_BAR_Y,
  renderMarkSvg,
} from '@/lib/brand-mark';

/**
 * Generates every brand raster from the shared vector geometry, so the favicon,
 * the app icon, and the social card can never drift from the logo in the app.
 *
 * Run with `npm run brand`. Output is committed: a build server should not have
 * to render images, and Google should never be served a different mark than the
 * browser tab.
 */

async function main() {
  const publicDir = path.resolve('public');
  const appDir = path.resolve('src/app');
  await mkdir(publicDir, { recursive: true });

  await writeFile(path.join(appDir, 'icon.svg'), `${renderMarkSvg({ size: 32 })}\n`);
  console.log('  src/app/icon.svg');

  const rasters = [
    // Google's favicon crawler prefers a square that is a multiple of 48.
    { file: 'icon-48.png', size: 48 },
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    // Apple applies its own mask, so ship a full-bleed square with padding.
    { file: 'apple-icon.png', size: 180, square: true, padding: 0.1 },
  ];

  for (const raster of rasters) {
    const svg = renderMarkSvg(raster);
    await sharp(Buffer.from(svg)).png().toFile(path.join(publicDir, raster.file));
    console.log(`  public/${raster.file}`);
  }

  await writeFile(path.join(appDir, 'favicon.ico'), await buildIco([16, 32, 48]));
  console.log('  src/app/favicon.ico');

  await sharp(Buffer.from(ogSvg())).png().toFile(path.join(publicDir, 'og.png'));
  console.log('  public/og.png');
}

/** The social card: mark, name, and promise, on black. */
function ogSvg(width = 1200, height = 630): string {
  const tile = 96;
  const x = 88;
  const y = 232;
  const scale = tile / 32;

  const bars = MARK_BARS.map(
    (bar) =>
      `<rect x="${(x + bar.x * scale).toFixed(2)}" y="${(y + MARK_BAR_Y * scale).toFixed(2)}" ` +
      `width="${(bar.w * scale).toFixed(2)}" height="${(MARK_BAR_HEIGHT * scale).toFixed(2)}" ` +
      `rx="1.5" fill="#ffffff"/>`,
  ).join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#000000"/>
  <rect x="${x}" y="${y}" width="${tile}" height="${tile}" rx="${(tile * 0.22).toFixed(1)}" fill="#000000" stroke="#ffffff" stroke-opacity="0.18" stroke-width="1.5"/>
  ${bars}
  <text x="${x + tile + 28}" y="${y + 62}" font-family="Helvetica, Arial, sans-serif" font-size="46" font-weight="600" fill="#ffffff" letter-spacing="-1">UPC Scanning</text>
  <text x="${x}" y="${y + 172}" font-family="Helvetica, Arial, sans-serif" font-size="34" fill="#a1a1ac">Barcodes in. Professional product images out.</text>
  <text x="${x}" y="${height - 74}" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#6c6c78" letter-spacing="1">upcscanning.com</text>
</svg>`;
}

/**
 * Minimal ICO container. sharp cannot write .ico, and the format is simple
 * enough that a dependency would cost more than it saves: a 6-byte header, one
 * 16-byte directory entry per size, then the PNGs back to back.
 */
async function buildIco(sizes: number[]): Promise<Buffer> {
  const images = await Promise.all(
    sizes.map((size) => sharp(Buffer.from(renderMarkSvg({ size }))).png().toBuffer()),
  );

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map((image, index) => {
    const size = sizes[index]!;
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.byteLength, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.byteLength;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
