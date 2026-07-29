import sharp from 'sharp';

/**
 * Global limits for libvips.
 *
 * sharp does its work outside the V8 heap, so none of this is visible to
 * `--max-old-space-size` and none of it shows up as a heap overflow. The
 * container simply exceeds its memory allowance and the platform kills it,
 * which is what a Railway "ran out of memory" notice actually reports.
 *
 * Three defaults are wrong for a container that processes images concurrently:
 *
 *  - the operation cache holds decoded intermediates in memory, which is a fine
 *    trade for a long-lived server serving the same few images and a poor one
 *    for a queue that never sees the same image twice;
 *  - concurrency defaults to the host's CPU count, and each thread allocates its
 *    own buffers, so the real multiplier is threads × concurrent jobs;
 *  - the input pixel limit is 268 megapixels, which is less a safeguard than an
 *    invitation: a 2 MB file can carry enough pixels to exhaust the container
 *    on its own.
 *
 * Applied once, at import.
 */

let applied = false;

export function applyImageLimits(): void {
  if (applied) return;
  applied = true;

  sharp.cache({ memory: 24, files: 0, items: 50 });
  // One thread per operation. Throughput comes from running more products at
  // once, which the queue already controls and which can be tuned per host;
  // internal parallelism only multiplies the peak of whatever is in flight.
  sharp.concurrency(1);
  sharp.simd(true);
}

applyImageLimits();

/**
 * Cap on decoded pixels, independent of file size.
 *
 * Compression ratio is not a property anyone controls: a download inside the
 * byte limit can still decode to something enormous, and the image search tier
 * fetches from hosts chosen by a model. Every sharp instance in this codebase
 * takes its options from here so the ceiling cannot be forgotten in one place.
 */
export const MAX_INPUT_PIXELS = 30_000_000;

export function decodeOptions(): { failOn: 'none'; limitInputPixels: number } {
  return { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS };
}
