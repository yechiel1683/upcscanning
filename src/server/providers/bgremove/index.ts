import { env } from '@/lib/env';
import { fetchWithTimeout, HttpError } from '@/server/lib/http';

/**
 * Background removal strategy.
 *
 * "auto" is handled inside the render pipeline (a border-seeded flood fill, see
 * images/background.ts) because it needs the decoded pixels anyway. The hosted
 * option exists for the cases the flood fill declines: soft edges, hair, glass,
 * or a product photographed in a real environment.
 */

export type BackgroundRemovalMode = 'auto' | 'removebg' | 'none';

export function backgroundRemovalMode(): BackgroundRemovalMode {
  const config = env();
  if (config.BACKGROUND_REMOVAL_PROVIDER === 'removebg' && !config.REMOVEBG_API_KEY) {
    // Configured but unusable: degrade rather than fail every product.
    return 'auto';
  }
  return config.BACKGROUND_REMOVAL_PROVIDER;
}

/**
 * Cut out the product with remove.bg. Returns a PNG with alpha.
 * Throws on failure so the caller can fall back to the local pipeline.
 */
export async function removeBackgroundHosted(buffer: Buffer): Promise<Buffer> {
  const config = env();
  if (!config.REMOVEBG_API_KEY) throw new HttpError('REMOVEBG_API_KEY is not set');

  const form = new FormData();
  form.append('image_file', new Blob([new Uint8Array(buffer)]), 'image.png');
  form.append('size', 'auto');
  // "product" biases the model toward isolated objects rather than people.
  form.append('type', 'product');
  form.append('format', 'png');

  const response = await fetchWithTimeout('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': config.REMOVEBG_API_KEY },
    body: form,
    timeoutMs: 60_000,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new HttpError(`remove.bg returned ${response.status}: ${body.slice(0, 200)}`, response.status);
  }

  return Buffer.from(await response.arrayBuffer());
}
