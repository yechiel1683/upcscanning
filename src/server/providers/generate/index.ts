import { env } from '@/lib/env';
import { fetchJson, fetchWithTimeout, HttpError, withRetry } from '@/server/lib/http';

/**
 * Workflow B: synthesise a product photo when no real one can be found.
 *
 * Anthropic models do not generate images, so generation is delegated to a
 * pluggable provider. Everything here returns raw PNG/JPEG bytes; the shared
 * sharp pipeline then applies the same framing, background, and sizing rules
 * that real photos get, so a mixed catalog still looks uniform.
 */

export interface GenerationRequest {
  prompt: string;
  /** Square output; the render pipeline resizes to the batch's target anyway. */
  size?: number;
}

export interface GenerationResult {
  buffer: Buffer;
  mimeType: string;
  provider: string;
  model: string;
}

export interface GenerationProvider {
  readonly name: string;
  isConfigured(): boolean;
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

// ---------------------------------------------------------------------------
// OpenAI gpt-image-1
// ---------------------------------------------------------------------------

interface OpenAiImageResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

const openAiProvider: GenerationProvider = {
  name: 'openai',

  isConfigured() {
    return Boolean(env().OPENAI_API_KEY);
  },

  async generate(request) {
    const config = env();
    const data = await withRetry(() =>
      fetchJson<OpenAiImageResponse>('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: config.OPENAI_IMAGE_MODEL,
          prompt: request.prompt,
          n: 1,
          size: '1024x1024',
          background: 'opaque',
          output_format: 'png',
        }),
        // Image generation is slow; give it well past the default timeout.
        timeoutMs: 120_000,
      }),
    );

    const first = data.data?.[0];
    if (first?.b64_json) {
      return {
        buffer: Buffer.from(first.b64_json, 'base64'),
        mimeType: 'image/png',
        provider: 'openai',
        model: config.OPENAI_IMAGE_MODEL,
      };
    }
    if (first?.url) {
      const response = await fetchWithTimeout(first.url, { timeoutMs: 60_000 });
      if (!response.ok) throw new HttpError(`Could not download generated image (${response.status})`);
      return {
        buffer: Buffer.from(await response.arrayBuffer()),
        mimeType: 'image/png',
        provider: 'openai',
        model: config.OPENAI_IMAGE_MODEL,
      };
    }

    throw new HttpError(data.error?.message ?? 'OpenAI returned no image data');
  },
};

// ---------------------------------------------------------------------------
// Replicate
// ---------------------------------------------------------------------------

interface ReplicatePrediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: string | string[];
  error?: string;
  urls?: { get?: string };
}

const replicateProvider: GenerationProvider = {
  name: 'replicate',

  isConfigured() {
    return Boolean(env().REPLICATE_API_TOKEN);
  },

  async generate(request) {
    const config = env();
    const headers = {
      authorization: `Bearer ${config.REPLICATE_API_TOKEN}`,
      'content-type': 'application/json',
    };

    let prediction = await withRetry(() =>
      fetchJson<ReplicatePrediction>(
        `https://api.replicate.com/v1/models/${config.REPLICATE_MODEL}/predictions`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            input: {
              prompt: request.prompt,
              aspect_ratio: '1:1',
              output_format: 'png',
              safety_tolerance: 2,
            },
          }),
          timeoutMs: 60_000,
        },
      ),
    );

    // Poll until the prediction resolves or we give up after ~3 minutes.
    const deadline = Date.now() + 180_000;
    while (
      (prediction.status === 'starting' || prediction.status === 'processing') &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      prediction = await fetchJson<ReplicatePrediction>(
        prediction.urls?.get ?? `https://api.replicate.com/v1/predictions/${prediction.id}`,
        { headers, timeoutMs: 30_000 },
      );
    }

    if (prediction.status !== 'succeeded') {
      throw new HttpError(prediction.error ?? `Replicate prediction ${prediction.status}`);
    }

    const output = Array.isArray(prediction.output) ? prediction.output[0] : prediction.output;
    if (!output) throw new HttpError('Replicate returned no output');

    const response = await fetchWithTimeout(output, { timeoutMs: 60_000 });
    if (!response.ok) throw new HttpError(`Could not download generated image (${response.status})`);

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: 'image/png',
      provider: 'replicate',
      model: config.REPLICATE_MODEL,
    };
  },
};

// ---------------------------------------------------------------------------
// Stability AI
// ---------------------------------------------------------------------------

const stabilityProvider: GenerationProvider = {
  name: 'stability',

  isConfigured() {
    return Boolean(env().STABILITY_API_KEY);
  },

  async generate(request) {
    const config = env();
    const form = new FormData();
    form.append('prompt', request.prompt);
    form.append('model', config.STABILITY_MODEL);
    form.append('aspect_ratio', '1:1');
    form.append('output_format', 'png');
    form.append('mode', 'text-to-image');

    const response = await fetchWithTimeout(
      'https://api.stability.ai/v2beta/stable-image/generate/sd3',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.STABILITY_API_KEY}`,
          accept: 'image/*',
        },
        body: form,
        timeoutMs: 120_000,
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpError(`Stability returned ${response.status}: ${body.slice(0, 200)}`, response.status);
    }

    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      mimeType: 'image/png',
      provider: 'stability',
      model: config.STABILITY_MODEL,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const PROVIDERS: Record<string, GenerationProvider> = {
  openai: openAiProvider,
  replicate: replicateProvider,
  stability: stabilityProvider,
};

/** The configured generation provider, or null when Workflow B is disabled. */
export function generationProvider(): GenerationProvider | null {
  const name = env().IMAGE_GENERATION_PROVIDER;
  if (name === 'none') return null;
  const provider = PROVIDERS[name];
  if (!provider || !provider.isConfigured()) return null;
  return provider;
}

export function generationStatus(): { enabled: boolean; provider: string | null; reason?: string } {
  const name = env().IMAGE_GENERATION_PROVIDER;
  if (name === 'none') {
    return { enabled: false, provider: null, reason: 'IMAGE_GENERATION_PROVIDER is "none"' };
  }
  const provider = PROVIDERS[name];
  if (!provider) return { enabled: false, provider: name, reason: `Unknown provider "${name}"` };
  if (!provider.isConfigured()) {
    return { enabled: false, provider: name, reason: `${name} is missing its API key` };
  }
  return { enabled: true, provider: name };
}
