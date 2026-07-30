import { env } from '@/lib/env';

/**
 * Outbound HTTP helpers shared by every provider.
 *
 * Two concerns are handled centrally: timeouts (a hung supplier CDN must not
 * hold a worker slot open) and SSRF safety (candidate image URLs come from
 * third-party search results and from user spreadsheets, so they are hostile
 * input by definition).
 */

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // Carrier-grade NAT
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
]);

/**
 * Reject URLs that point at the local network. Not a complete SSRF defence on
 * its own — DNS can still resolve a public name to a private address — but it
 * removes the trivial cases, and image fetches additionally refuse redirects
 * to blocked hosts.
 */
export function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(`Malformed URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(`Refusing non-HTTP URL: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new HttpError(`Refusing to fetch internal host: ${host}`);
  }
  if (PRIVATE_V4.some((re) => re.test(host))) {
    throw new HttpError(`Refusing to fetch private address: ${host}`);
  }
  // IPv6 loopback / link-local / unique-local.
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    throw new HttpError(`Refusing to fetch private address: ${host}`);
  }
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  if (host.startsWith('::ffff:') && PRIVATE_V4.some((re) => re.test(host.slice(7)))) {
    throw new HttpError(`Refusing to fetch private address: ${host}`);
  }

  return url;
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
}

export async function fetchWithTimeout(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const { timeoutMs, ...init } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? env().HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(`Request to ${new URL(url).hostname} timed out`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new HttpError(
      `${new URL(url).hostname} returned ${response.status}: ${body.slice(0, 200)}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

/**
 * Download binary content with a hard size ceiling, enforced while streaming so
 * a malicious server cannot exhaust memory by omitting content-length.
 */
export async function fetchBinary(
  url: string,
  options: FetchOptions & { maxBytes?: number } = {},
): Promise<{ buffer: Buffer; contentType: string; lastModified: string | null }> {
  const { maxBytes = env().MAX_IMAGE_DOWNLOAD_BYTES, ...rest } = options;
  assertPublicUrl(url);

  const response = await fetchWithTimeout(url, {
    ...rest,
    redirect: 'follow',
    headers: {
      // Some CDNs serve a 403 to clients without a browser-shaped UA.
      'user-agent':
        'Mozilla/5.0 (compatible; UPCScanning/1.0; +https://github.com/yechiel1683/upcscanning)',
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5',
      ...rest.headers,
    },
  });

  if (!response.ok) {
    throw new HttpError(`Image host returned ${response.status}`, response.status);
  }

  // The final URL after redirects must also be safe.
  if (response.url) assertPublicUrl(response.url);

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new HttpError(`Image is ${Math.round(declared / 1024)}KB, over the size limit`);
  }

  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  // Kept because it is the only date most image hosts ever state, and choosing
  // between two photographs of the same product needs one.
  const lastModified = response.headers.get('last-modified');

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new HttpError('Image exceeded the size limit');
    return { buffer, contentType, lastModified };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError('Image exceeded the size limit while downloading');
    }
    chunks.push(Buffer.from(value));
  }

  return { buffer: Buffer.concat(chunks), contentType, lastModified };
}

/** Retry helper for flaky upstreams. Only retries transient failures. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 400 } = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error instanceof HttpError ? error.status : undefined;
      // 4xx other than 408/429 will not succeed on a retry.
      if (status && status < 500 && status !== 408 && status !== 429) throw error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
