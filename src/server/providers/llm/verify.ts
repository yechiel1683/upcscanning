import sharp from 'sharp';

import { env } from '@/lib/env';
import { fetchJson } from '@/server/lib/http';
import { decodeOptions } from '@/server/images/limits';

/**
 * Does this picture show the product we said it does?
 *
 * Nothing else in the pipeline asks. Match scoring reads titles, URLs and
 * barcodes — text *about* an image, never the image — and a generated image is
 * not scored at all, because it was made to order and was assumed to depict
 * what it was asked for. It does not always. A body wash came back as a box of
 * tea, correctly named, correctly labelled "AI generated", and completely
 * wrong.
 *
 * That failure is worse than returning nothing. A missing image is a gap
 * somebody fills; a confident wrong one goes into a catalog and is sold from.
 * So the last thing before an image is accepted is to look at it.
 *
 * The check is deliberately one-sided. It has to be certain to *reject*: an
 * unreadable answer, a missing key, a provider outage all resolve to "unknown"
 * and let the image through, because refusing every product when the verifier
 * is down would be its own outage. Only a clear "this is a different product"
 * stops anything.
 */

export type Verdict = 'match' | 'mismatch' | 'unknown';

export interface VerificationResult {
  verdict: Verdict;
  /** What the image actually appears to show. Empty when unknown. */
  shown: string;
  reason: string;
}

export interface VerificationInput {
  buffer: Buffer;
  title: string;
  brand?: string | null;
  category?: string | null;
  /** Hold an invented image to the harder standard. See STRICT_SYSTEM_PROMPT. */
  strict?: boolean;
}

/** Enough pixels to recognise a product, few enough to be nearly free. */
const PROBE_EDGE = 512;

/** Below this the model is not sure enough for its answer to be worth acting on. */
const MIN_CONFIDENCE = 0.6;

const SYSTEM_PROMPT = `You check whether a product photograph shows the product it is supposed to show.

Respond with a single JSON object and nothing else:
{
  "shown": string,      // what the image actually shows, in a few words
  "depicts": boolean,   // true only if the image plausibly shows the stated product
  "confidence": number  // 0 to 1
}

Judge the product category and identity, not photographic quality, packaging
variation, or a different flavour, scent, size or count of the same product —
those count as depicting it. A different kind of product entirely does not.
If the image is too unclear to tell, set depicts to true and confidence below 0.5.`;

/**
 * The bar for an invented image, which is a different question.
 *
 * A real photograph found for a stated product is either that product or
 * something else, and "a body wash" is a reasonable answer. An image model
 * asked for a body wash will always return something that is recognisably a
 * body wash — a blank-labelled bottle, a generic pump dispenser, occasionally
 * one with the barcode number printed across the front — and passing those is
 * exactly how a catalog fills up with containers that are not anyone's product.
 *
 * So a generated image is asked the harder question: is this recognisably the
 * *stated brand's* product, rather than a plausible member of its category.
 */
const STRICT_SYSTEM_PROMPT = `You check whether a generated product image is usable as a catalog photograph of a specific named product.

Respond with a single JSON object and nothing else:
{
  "shown": string,      // what the image actually shows, in a few words
  "depicts": boolean,   // see below
  "confidence": number  // 0 to 1
}

Set depicts to false, with high confidence, when any of these is true:
- the packaging is blank, unbranded, or carries invented or placeholder text
- it shows a generic container of the right category rather than the named product
- the stated product has a well-known brand and its branding is absent or wrong
- any digits, codes or filler text appear on the packaging that would not be on the real product

Set depicts to true only when the image is recognisably the named brand's
product. Being the right category is not enough.`;

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export function verificationAvailable(): boolean {
  return Boolean(env().OPENAI_API_KEY);
}

export async function verifyProductImage(
  input: VerificationInput,
): Promise<VerificationResult> {
  const config = env();
  if (!config.OPENAI_API_KEY) {
    return { verdict: 'unknown', shown: '', reason: 'No vision provider configured' };
  }

  try {
    const probe = await sharp(input.buffer, decodeOptions())
      .rotate()
      .resize(PROBE_EDGE, PROBE_EDGE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 80 })
      .toBuffer();

    const described = [
      input.title,
      input.brand ? `Brand: ${input.brand}` : '',
      input.category ? `Category: ${input.category}` : '',
    ]
      .filter(Boolean)
      .join('. ');

    const data = await fetchJson<ChatResponse>('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.OPENAI_TEXT_MODEL,
        messages: [
          { role: 'system', content: input.strict ? STRICT_SYSTEM_PROMPT : SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Stated product: ${described}` },
              {
                type: 'image_url',
                image_url: { url: `data:image/jpeg;base64,${probe.toString('base64')}`, detail: 'low' },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 200,
      }),
      timeoutMs: 30_000,
    });

    if (data.error?.message) {
      return { verdict: 'unknown', shown: '', reason: data.error.message };
    }

    return interpret(data.choices?.[0]?.message?.content ?? '', input.strict ?? false);
  } catch (error) {
    return {
      verdict: 'unknown',
      shown: '',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read the model's answer.
 *
 * Split out so the part that decides whether a product ships can be tested
 * without a network, including the shapes a model returns when it is having a
 * bad day.
 */
export function interpret(raw: string, strict = false): VerificationResult {
  let parsed: { shown?: unknown; depicts?: unknown; confidence?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { verdict: 'unknown', shown: '', reason: 'Verifier returned unparseable output' };
  }

  const shown = typeof parsed.shown === 'string' ? parsed.shown.trim() : '';
  if (typeof parsed.depicts !== 'boolean') {
    return { verdict: 'unknown', shown, reason: 'Verifier gave no verdict' };
  }

  const confidence =
    typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

  if (parsed.depicts) return { verdict: 'match', shown, reason: 'Image matches the product' };

  // A rejection has to be a confident one. An uncertain "no" from a model
  // looking at a blurry thumbnail is not grounds for discarding a real
  // photograph of the right thing.
  // An uncertain "no" about a *found* photograph is not grounds for discarding
  // it. About an *invented* one it is: there was nothing to lose in the first
  // place, and the cost of being wrong runs entirely one way.
  if (!strict && confidence < MIN_CONFIDENCE) {
    return { verdict: 'unknown', shown, reason: 'Verifier was not confident enough to reject' };
  }

  return {
    verdict: 'mismatch',
    shown,
    reason: shown ? `The image shows ${shown}` : 'The image shows a different product',
  };
}
