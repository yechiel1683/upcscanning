import type {
  ProductEnrichment,
  RenderOptions,
  SearchCandidate,
} from '@/lib/types';
import { env } from '@/lib/env';
import { fetchBinary } from '@/server/lib/http';
import { analyseImage, renderProductImage, type RenderResult } from '@/server/images/render';
import {
  CONFIDENT_MATCH_THRESHOLD,
  MINIMUM_MATCH_THRESHOLD,
  MINIMUM_QUALITY_THRESHOLD,
  scoreMatch,
  scoreQuality,
} from '@/server/images/quality';
import { generationProvider } from '@/server/providers/generate';
import { backgroundRemovalMode, removeBackgroundHosted } from '@/server/providers/bgremove';
import { enrichProduct, type EnrichmentInput } from '@/server/providers/llm/enrichment';
import { gatherCandidates } from '@/server/providers/search';

/**
 * The per-product engine.
 *
 * Workflow A (find the real photo) is tried first and exhaustively; Workflow B
 * (generate one) only runs when A produces nothing usable. The function is pure
 * with respect to the database — it takes a plain product and returns a
 * decision — so it can be unit tested and reused by the API's single-product
 * preview endpoint as well as by the queue worker.
 */

export interface ProcessInput {
  product: {
    id: string;
    rowNumber: number;
    name: string;
    sku?: string | null;
    upc?: string | null;
    brand?: string | null;
    model?: string | null;
    description?: string | null;
    specifications?: string | null;
    category?: string | null;
    imageUrl?: string | null;
  };
  options: RenderOptions;
  /** Reuse a previously computed enrichment on retry instead of paying twice. */
  cachedEnrichment?: ProductEnrichment | null;
  /** Cap on how many candidates get downloaded before giving up. */
  maxDownloads?: number;
}

export interface EvaluatedCandidate {
  candidate: SearchCandidate;
  matchScore: number;
  qualityScore: number;
  rejected: boolean;
  rejectedReason?: string;
  selected: boolean;
}

export type ProcessOutcome =
  | {
      status: 'succeeded';
      kind: 'REAL' | 'AI_GENERATED' | 'USER_PROVIDED';
      render: RenderResult;
      enrichment: ProductEnrichment;
      provider: string;
      sourceUrl?: string;
      matchScore: number;
      qualityScore: number;
      candidates: EvaluatedCandidate[];
      log: string[];
    }
  | {
      status: 'failed';
      reason: string;
      enrichment: ProductEnrichment;
      candidates: EvaluatedCandidate[];
      log: string[];
    };

const DEFAULT_MAX_DOWNLOADS = 5;
const CANDIDATE_LIMIT = 12;

export async function processProduct(input: ProcessInput): Promise<ProcessOutcome> {
  const log: string[] = [];
  const { product, options } = input;

  // --- 1. Understand the product -----------------------------------------
  const enrichmentInput: EnrichmentInput = {
    name: product.name,
    brand: product.brand,
    model: product.model,
    upc: product.upc,
    sku: product.sku,
    description: product.description,
    specifications: product.specifications,
    category: product.category,
  };

  const enrichment = input.cachedEnrichment ?? (await enrichProduct(enrichmentInput));
  log.push(
    `Identified "${enrichment.canonicalTitle}"` +
      (enrichment.brand ? ` (brand: ${enrichment.brand}` : '') +
      (enrichment.model ? `, model: ${enrichment.model}` : '') +
      (enrichment.brand ? ')' : '') +
      ` via ${enrichment.source}`,
  );

  // --- 2. Workflow A: find a real image -----------------------------------
  const evaluated: EvaluatedCandidate[] = [];

  const { candidates, errors } = await gatherCandidates(
    {
      upc: product.upc,
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      model: product.model,
      enrichment,
      limit: CANDIDATE_LIMIT,
    },
    { directImageUrl: product.imageUrl },
  );

  for (const error of errors) log.push(`Search provider ${error.provider} failed: ${error.message}`);
  log.push(`Found ${candidates.length} image candidate(s)`);

  // Score every candidate on text signals before spending bandwidth.
  const ranked = candidates
    .map((candidate) => {
      const assessment = scoreMatch({
        candidate,
        enrichment,
        upc: product.upc,
        model: product.model,
      });
      return { candidate, assessment };
    })
    .sort((a, b) => b.assessment.score - a.assessment.score);

  for (const { candidate, assessment } of ranked) {
    if (assessment.rejected || assessment.score < MINIMUM_MATCH_THRESHOLD) {
      evaluated.push({
        candidate,
        matchScore: assessment.score,
        qualityScore: 0,
        rejected: true,
        rejectedReason:
          assessment.reason ?? `Match confidence ${assessment.score.toFixed(2)} below threshold`,
        selected: false,
      });
    }
  }

  const viable = ranked.filter(
    (r) => !r.assessment.rejected && r.assessment.score >= MINIMUM_MATCH_THRESHOLD,
  );

  const maxDownloads = input.maxDownloads ?? DEFAULT_MAX_DOWNLOADS;
  let best: {
    candidate: SearchCandidate;
    matchScore: number;
    qualityScore: number;
    render: RenderResult;
  } | null = null;

  let downloads = 0;
  for (const { candidate, assessment } of viable) {
    if (downloads >= maxDownloads) break;
    // Stop early once we hold something that is both a confident match and a
    // good photo — extra downloads cost time and add nothing.
    if (best && best.matchScore >= CONFIDENT_MATCH_THRESHOLD && best.qualityScore >= 0.75) break;

    downloads += 1;

    try {
      const source = await downloadAndPrepare(candidate.sourceUrl);
      const analysis = await analyseImage(source);

      const quality = scoreQuality({
        width: analysis.width,
        height: analysis.height,
        bytes: source.byteLength,
        borderVariance: analysis.borderVariance,
        foregroundRatio: analysis.foregroundRatio,
        detail: analysis.detail,
        hasAlpha: analysis.hasAlpha,
      });

      if (quality.rejected || quality.score < MINIMUM_QUALITY_THRESHOLD) {
        evaluated.push({
          candidate,
          matchScore: assessment.score,
          qualityScore: quality.score,
          rejected: true,
          rejectedReason: quality.reason ?? `Quality ${quality.score.toFixed(2)} below threshold`,
          selected: false,
        });
        log.push(`Rejected ${hostOf(candidate.sourceUrl)}: ${quality.reason ?? 'low quality'}`);
        continue;
      }

      const prepared = await maybeHostedCutout(source, options, log);
      const render = await renderProductImage({ buffer: prepared, options });

      const combined = assessment.score * 0.65 + quality.score * 0.35;
      const bestCombined = best ? best.matchScore * 0.65 + best.qualityScore * 0.35 : -1;

      if (combined > bestCombined) {
        best = {
          candidate,
          matchScore: assessment.score,
          qualityScore: quality.score,
          render,
        };
      }

      evaluated.push({
        candidate,
        matchScore: assessment.score,
        qualityScore: quality.score,
        rejected: false,
        selected: false,
      });
      log.push(
        `Accepted ${hostOf(candidate.sourceUrl)} — match ${assessment.score.toFixed(2)}, quality ${quality.score.toFixed(2)} (${quality.notes.join(', ') || 'no notes'})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evaluated.push({
        candidate,
        matchScore: assessment.score,
        qualityScore: 0,
        rejected: true,
        rejectedReason: message,
        selected: false,
      });
      log.push(`Failed to fetch ${hostOf(candidate.sourceUrl)}: ${message}`);
    }
  }

  if (best) {
    const winner = evaluated.find((e) => e.candidate.sourceUrl === best!.candidate.sourceUrl);
    if (winner) winner.selected = true;

    return {
      status: 'succeeded',
      kind: best.candidate.provider === 'spreadsheet' ? 'USER_PROVIDED' : 'REAL',
      render: best.render,
      enrichment,
      provider: best.candidate.provider,
      sourceUrl: best.candidate.sourceUrl,
      matchScore: best.matchScore,
      qualityScore: best.qualityScore,
      candidates: evaluated,
      log,
    };
  }

  // --- 3. Workflow B: generate --------------------------------------------
  if (!options.allowAiGeneration) {
    return {
      status: 'failed',
      reason:
        candidates.length === 0
          ? 'No product image could be found, and AI generation is turned off for this batch.'
          : 'No candidate image passed the match and quality checks, and AI generation is turned off for this batch.',
      enrichment,
      candidates: evaluated,
      log,
    };
  }

  const generator = generationProvider();
  if (!generator) {
    return {
      status: 'failed',
      reason:
        'No real product image was found and no AI image provider is configured. ' +
        'Set IMAGE_GENERATION_PROVIDER and the matching API key to enable fallback generation.',
      enrichment,
      candidates: evaluated,
      log,
    };
  }

  try {
    log.push(`Generating a product image with ${generator.name}`);
    const generated = await generator.generate({ prompt: enrichment.generationPrompt });
    const prepared = await maybeHostedCutout(generated.buffer, options, log);

    const render = await renderProductImage({
      buffer: prepared,
      options,
      aiBadge: options.watermarkAiImages,
    });

    return {
      status: 'succeeded',
      kind: 'AI_GENERATED',
      render,
      enrichment,
      provider: `${generated.provider}:${generated.model}`,
      matchScore: 0,
      // A generated image is clean by construction, but it is not the real
      // product, so it never scores as highly as a verified photograph.
      qualityScore: 0.7,
      candidates: evaluated,
      log,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.push(`Generation failed: ${message}`);
    return {
      status: 'failed',
      reason: `No real image found, and AI generation failed: ${message}`,
      enrichment,
      candidates: evaluated,
      log,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACCEPTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/tiff',
]);

async function downloadAndPrepare(url: string): Promise<Buffer> {
  const { buffer, contentType } = await fetchBinary(url, {
    maxBytes: env().MAX_IMAGE_DOWNLOAD_BYTES,
  });

  if (contentType && !ACCEPTED_IMAGE_TYPES.has(contentType)) {
    // Some CDNs mislabel content types, so sniff the magic bytes before
    // rejecting outright.
    if (!looksLikeImage(buffer)) {
      throw new Error(`Not an image (content-type: ${contentType || 'unknown'})`);
    }
  } else if (!contentType && !looksLikeImage(buffer)) {
    throw new Error('Response did not contain image data');
  }

  return buffer;
}

function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return true;
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return true;
  }
  // RIFF....WEBP
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return true;
  }
  // TIFF
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a) ||
    (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00)
  ) {
    return true;
  }
  // AVIF / HEIF share the ISO-BMFF 'ftyp' box.
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return true;
  return false;
}

/**
 * Give the hosted matting service first refusal when it is configured. On any
 * failure we hand the original bytes back and let the local pipeline try.
 */
async function maybeHostedCutout(
  buffer: Buffer,
  options: RenderOptions,
  log: string[],
): Promise<Buffer> {
  if (!options.removeBackground && options.background !== 'transparent') return buffer;
  if (backgroundRemovalMode() !== 'removebg') return buffer;

  try {
    const cutout = await removeBackgroundHosted(buffer);
    log.push('Background removed with remove.bg');
    return cutout;
  } catch (error) {
    log.push(
      `remove.bg unavailable (${error instanceof Error ? error.message : String(error)}); using the built-in cutout`,
    );
    return buffer;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}
