import type {
  ProductEnrichment,
  ProductFacts,
  RenderOptions,
  SearchCandidate,
} from '@/lib/types';
import { env } from '@/lib/env';
import { mergeFacts } from '@/lib/types';
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
import {
  enrichProduct,
  heuristicEnrichment,
  type EnrichmentInput,
} from '@/server/providers/llm/enrichment';
import {
  availableProviders,
  lookupBarcodeCached,
  searchWeb,
  type SearchContext,
} from '@/server/providers/search';
import { Memo } from '@/server/lib/memo';
import { scoreRecency } from '@/server/images/recency';
import { canonicalImageKey, largerVariants } from '@/server/images/variants';
import { verificationAvailable, verifyProductImage } from '@/server/providers/llm/verify';

/**
 * The per-product engine.
 *
 * The order matters and is barcode-first by design. Given nothing but a
 * number, we ask the barcode databases what the product *is* before asking
 * anyone where its picture lives — because "036000291452" is an unsearchable
 * query, while "Duracell Coppertop AA Batteries 8 Pack" is a very good one.
 *
 *   resolve barcode -> identify -> search web -> verify -> render
 *                                             \-> generate (Workflow B)
 *
 * The function is pure with respect to the database: it takes a plain product
 * and returns a decision, so it can be unit tested and reused by a
 * single-product preview as well as by the queue worker.
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
  /**
   * How hard to try, for a row that has already come back empty once.
   *
   * Retrying a product identically is not a retry, it is the same request with
   * the same answer — so each pass has to change something. The ladder widens
   * the search first and lowers the bar only at the end, because a wider search
   * can still find the right picture while a lower bar can only ever accept a
   * worse one.
   */
  effort?: Effort;
}

export type Effort = 'normal' | 'wider' | 'lenient';

const DEFAULT_MAX_DOWNLOADS = 5;
const CANDIDATE_LIMIT = 12;

interface EffortSettings {
  maxDownloads: number;
  candidateLimit: number;
  /** Always consult the open web, even when the barcode tier looked fine. */
  forceWeb: boolean;
  /** Floor a downloaded image must clear. */
  minQuality: number;
  /** Accept a usable-but-poor image, flagged, rather than returning nothing. */
  acceptMarginal: boolean;
}

export const EFFORT: Record<Effort, EffortSettings> = {
  normal: {
    maxDownloads: DEFAULT_MAX_DOWNLOADS,
    candidateLimit: CANDIDATE_LIMIT,
    forceWeb: false,
    minQuality: MINIMUM_QUALITY_THRESHOLD,
    acceptMarginal: false,
  },
  // Same standards, more places looked and more candidates weighed. Most
  // second-pass successes come from here: the first pass simply stopped early.
  wider: {
    maxDownloads: 10,
    candidateLimit: 24,
    forceWeb: true,
    minQuality: MINIMUM_QUALITY_THRESHOLD,
    acceptMarginal: false,
  },
  // Last pass. The bar drops to what is still recognisably a product photo,
  // and anything taken at this level is handed back marked for review rather
  // than presented as a confident answer.
  lenient: {
    maxDownloads: 10,
    candidateLimit: 24,
    forceWeb: true,
    minQuality: 0.12,
    acceptMarginal: true,
  },
};

/**
 * What an empty row is tried at, in order, before it is called a failure.
 *
 * Lives here, beside the settings it names, because both runners walk it — the
 * guest path as a loop and the account path from a product's attempt counter —
 * and a ladder defined twice is a ladder that will eventually differ.
 */
export const EFFORT_LADDER = ['normal', 'wider', 'lenient'] as const satisfies readonly Effort[];

/**
 * The rung for a given pass. `attempts` has already been incremented for the
 * pass about to run, and it clamps: a manual retry of a row that has already
 * exhausted the ladder runs at the most forgiving setting rather than failing
 * on an index.
 */
export function effortForAttempt(attempts: number): Effort {
  const index = Math.min(Math.max(attempts, 1), EFFORT_LADDER.length) - 1;
  return EFFORT_LADDER[index]!;
}

export interface EvaluatedCandidate {
  candidate: SearchCandidate;
  matchScore: number;
  qualityScore: number;
  rejected: boolean;
  rejectedReason?: string;
  selected: boolean;
}

/**
 * A second image that was a real contender for the same product.
 *
 * Ranking already picks the most accurate of several plausible photographs, but
 * "most accurate" is a score, and when the scores are close the person filling
 * the catalog is better placed to judge than the number is. Keeping the runner
 * up means an uncertain row can offer a swap instead of only accept-or-empty.
 *
 * Deliberately just a URL and its scores: rendering every contender would
 * multiply the memory a batch holds, for pictures nobody may ever ask to see.
 * The swap renders on demand, usually straight out of the render cache.
 */
export interface Alternative {
  sourceUrl: string;
  provider: string;
  matchScore: number;
  qualityScore: number;
}

/** How many contenders are worth keeping. Two choices is a decision; six is a search. */
const MAX_ALTERNATIVES = 2;

interface SuccessOutcome {
  status: 'succeeded';
  /**
   * An image was produced but is not a confident answer — it cleared only the
   * relaxed bar of a final retry. Worth showing to somebody, not worth filing
   * silently.
   */
  needsReview?: boolean;
  reviewReason?: string;
  kind: 'REAL' | 'AI_GENERATED' | 'USER_PROVIDED';
  render: RenderResult;
  enrichment: ProductEnrichment;
  /** Product details discovered during lookup, for the export and the UI. */
  facts?: ProductFacts;
  provider: string;
  sourceUrl?: string;
  matchScore: number;
  qualityScore: number;
  /** Other credible images of the same product, best first. */
  alternatives: Alternative[];
  candidates: EvaluatedCandidate[];
  log: string[];
}

interface FailureOutcome {
  status: 'failed';
  reason: string;
  enrichment: ProductEnrichment;
  facts?: ProductFacts;
  candidates: EvaluatedCandidate[];
  log: string[];
}

export type ProcessOutcome = SuccessOutcome | FailureOutcome;


/**
 * Rendered images, keyed by where they came from and how they were rendered.
 *
 * The same barcode run twice re-downloaded the same photograph, re-analysed it
 * and re-rendered it to produce a byte-identical result. Nothing about that
 * work depends on anything but the source URL and the render options, so the
 * second run can skip all of it — which is the difference between "a few
 * seconds" and "instant" for the case somebody is actually watching: trying the
 * same code again.
 *
 * Small on purpose. Each entry holds a finished JPEG, so forty of them is a few
 * megabytes, and memory is the constraint that kills this container.
 */
interface RememberedImage {
  render: RenderResult;
  qualityScore: number;
}

const renderedImages = new Memo<RememberedImage>({ ttlMs: 60 * 60_000, max: 40 });

/** Test hook: forget rendered images. */
export function resetRenderMemo(): void {
  renderedImages.clear();
}

/**
 * Render one specific image, for somebody who has looked at the choice the
 * pipeline made and wants the other one.
 *
 * No search, no scoring, no verification: the candidate was already downloaded,
 * scored and cleared during processing, and the person asking has now seen it.
 * Usually this is a cache hit and returns without touching the network.
 */
export async function renderAlternative(
  sourceUrl: string,
  options: RenderOptions,
): Promise<{ render: RenderResult; qualityScore: number }> {
  const remembered = renderedImages.get(renderKey(sourceUrl, options));
  if (remembered) return { render: remembered.render, qualityScore: remembered.qualityScore };

  const { buffer } = await downloadAndPrepare(sourceUrl);
  const analysis = await analyseImage(buffer);
  const quality = scoreQuality({
    width: analysis.width,
    height: analysis.height,
    bytes: buffer.byteLength,
    borderVariance: analysis.borderVariance,
    foregroundRatio: analysis.foregroundRatio,
    detail: analysis.detail,
    hasAlpha: analysis.hasAlpha,
    overlayShare: analysis.overlayShare,
  });

  const prepared = await maybeHostedCutout(buffer, options, []);
  const render = await renderProductImage({ buffer: prepared, options });

  renderedImages.set(renderKey(sourceUrl, options), { render, qualityScore: quality.score });
  return { render, qualityScore: quality.score };
}

/** What actually determines the output, so nothing stale is ever served. */
function renderKey(sourceUrl: string, options: RenderOptions): string {
  return [
    sourceUrl,
    options.width,
    options.height,
    options.format,
    options.quality,
    options.background,
    options.padding,
    options.removeBackground ? 'cut' : 'keep',
    options.dropShadow ? 'shadow' : 'flat',
  ].join('|');
}

/** Is there anywhere to look beyond the barcode databases? */
function webSearchConfigured(): boolean {
  return availableProviders('web').length > 0;
}

/** A name we invented from a barcode carries no information worth searching. */
function isPlaceholderName(name: string, upc?: string | null, sku?: string | null): boolean {
  const trimmed = name.trim();
  if (upc && trimmed === `Product ${upc}`) return true;
  if (sku && trimmed === `Product ${sku}`) return true;
  return /^product\s+[\d-]+$/i.test(trimmed);
}

export async function processProduct(input: ProcessInput): Promise<ProcessOutcome> {
  const log: string[] = [];
  const { product, options } = input;
  const effort = EFFORT[input.effort ?? 'normal'];
  const maxDownloads = input.maxDownloads ?? effort.maxDownloads;
  const evaluated: EvaluatedCandidate[] = [];
  if (input.effort && input.effort !== 'normal') {
    log.push(`Retrying at "${input.effort}" effort`);
  }

  // --- 1. Resolve the barcode --------------------------------------------
  // Runs before identification so the model is reasoning about a real product
  // rather than a bare number.
  let facts: ProductFacts | undefined;
  const barcodeCandidates: SearchCandidate[] = [];

  if (product.upc) {
    // Heuristics are enough here: barcode providers key on the GTIN alone, so
    // paying for a model call before we know what the product is would be
    // spending twice for the same answer.
    const provisional = heuristicEnrichment(toEnrichment(product));
    const lookup = await lookupBarcodeCached({
      upc: product.upc,
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      model: product.model,
      enrichment: provisional,
      limit: effort.candidateLimit,
    });

    for (const error of lookup.errors) {
      log.push(`Barcode lookup ${error.provider} failed: ${error.message}`);
    }

    facts = lookup.facts;
    barcodeCandidates.push(...lookup.candidates);

    if (facts) {
      log.push(
        `Barcode ${product.upc} resolved to "${facts.title ?? 'unnamed product'}"` +
          (facts.brand ? ` by ${facts.brand}` : '') +
          ` via ${facts.source}` +
          (lookup.cached ? ' (cached)' : ''),
      );
    } else {
      log.push(`Barcode ${product.upc} is not in any configured product database`);
    }
  }

  // Facts fill gaps in the spreadsheet; they never overwrite what the supplier
  // explicitly stated, except when the supplier stated nothing usable.
  const resolved = {
    ...product,
    name:
      isPlaceholderName(product.name, product.upc, product.sku) && facts?.title
        ? facts.title
        : product.name,
    brand: product.brand ?? facts?.brand ?? null,
    model: product.model ?? facts?.model ?? null,
    category: product.category ?? facts?.category ?? null,
    description: product.description ?? facts?.description ?? null,
  };

  // --- 2. Identify --------------------------------------------------------
  //
  // Deliberately not a model call yet. Identification exists to turn a vague row
  // into a good *search query*, and a GTIN hit needs no query: the barcode
  // databases keyed on the number and handed back both the product and its
  // pictures. Paying a language model a second or two to describe a product we
  // have already identified, in order to rank images we already hold, is the
  // single largest avoidable delay between typing a barcode and seeing it.
  //
  // So the cheap local enrichment carries the barcode tier, and the model is
  // consulted only if that tier comes up short and we have to go to the web.
  let enrichment: ProductEnrichment =
    input.cachedEnrichment ?? heuristicEnrichment(toEnrichment(resolved));

  const searchContext: SearchContext = {
    upc: resolved.upc,
    sku: resolved.sku,
    name: resolved.name,
    brand: resolved.brand,
    model: resolved.model,
    enrichment,
    limit: effort.candidateLimit,
  };

  // --- 3. Try the barcode images first ------------------------------------
  let best = await evaluateCandidates({
    candidates: barcodeCandidates,
    searchContext,
    product: resolved,
    options,
    evaluated,
    log,
    maxDownloads,
    minQuality: effort.minQuality,
  });

  // --- 4. Go to the open web ----------------------------------------------
  //
  // Not only when the barcode tier came up empty. A GTIN lookup is the most
  // reliable way to know what a product *is* and among the least reliable ways
  // to see what it looks like today: its picture is whatever was attached when
  // the record was made, and records are made once. Stopping at the first good
  // image therefore reliably picks the oldest one in existence — a packaging
  // design two refreshes out of date, having passed every check this pipeline
  // has, because every one of them is about identity rather than currency.
  //
  // So with preferNewest on, the web is searched even when the barcode tier
  // already produced something acceptable, and recency joins the decision.
  const goodEnough = (result: typeof best) =>
    Boolean(result && result.matchScore >= CONFIDENT_MATCH_THRESHOLD && result.qualityScore >= 0.7);

  const barcodeImageLooksArchival =
    best !== null && scoreRecency({ sourceUrl: best.candidate.sourceUrl }).score < 0.5;

  let searchedWeb = false;
  let webErrors: Array<{ provider: string; message: string }> = [];
  if (!goodEnough(best) || effort.forceWeb || (options.preferNewest && barcodeImageLooksArchival)) {
    searchedWeb = true;

    // Now it is worth a model call: we are about to search the open web, where
    // the query and the negative keywords are what stand between a product and
    // its accessories.
    if (!input.cachedEnrichment) {
      enrichment = await enrichProduct(toEnrichment(resolved));
      searchContext.enrichment = enrichment;
    }
    log.push(
      `Identified "${enrichment.canonicalTitle}"` +
        (enrichment.brand ? ` (brand: ${enrichment.brand}` : '') +
        (enrichment.model ? `, model: ${enrichment.model}` : '') +
        (enrichment.brand ? ')' : '') +
        ` via ${enrichment.source}`,
    );
    const web = await searchWeb(searchContext, { directImageUrl: product.imageUrl });
    webErrors = web.errors;
    for (const error of web.errors) {
      log.push(`Search provider ${error.provider} failed: ${error.message}`);
    }
    log.push(`Web search returned ${web.candidates.length} candidate(s)`);

    // The web tier can also identify a product the barcode databases missed.
    facts = mergeFacts([facts, web.facts]);

    const fromWeb = await evaluateCandidates({
      candidates: web.candidates,
      searchContext,
      product: resolved,
      options,
      evaluated,
      log,
      maxDownloads,
      minQuality: effort.minQuality,
      incumbent: best,
    });

    if (fromWeb) best = fromWeb;
  }

  if (best) {
    // A real photograph the text signals were not certain about gets looked at
    // too. Titles, URLs and barcodes describe an image without ever seeing it,
    // which is enough when a GTIN lookup hands back the manufacturer's own
    // photo and much less so when a web search returns something that merely
    // reads right. A confident match skips this: it costs a call and a second,
    // and the whole point of the barcode-first order is that those cases are
    // already settled.
    // A cached winner was already verified the first time it was accepted, and
    // nothing about the image has changed since.
    if (best.source && best.matchScore < CONFIDENT_MATCH_THRESHOLD && verificationAvailable()) {
      const check = await verifyProductImage({
        buffer: best.source,
        title: enrichment.canonicalTitle,
        brand: enrichment.brand,
        category: enrichment.category,
      });
      if (check.verdict === 'mismatch') {
        const entry = evaluated.find(
          (candidate) => candidate.candidate.sourceUrl === best!.candidate.sourceUrl,
        );
        if (entry) {
          entry.rejected = true;
          entry.rejectedReason = check.reason;
        }
        log.push(`Rejected ${hostOf(best.candidate.sourceUrl)}: ${check.reason}`);
        best = null;
      }
    }
  }

  if (best) {
    // The one render in the whole of Workflow A.
    try {
      let render = best.cached;
      if (!render) {
        const prepared = await maybeHostedCutout(best.source!, options, log);
        render = await renderProductImage({ buffer: prepared, options });
        renderedImages.set(renderKey(best.candidate.sourceUrl, options), {
          render,
          qualityScore: best.qualityScore,
        });
      }

      const winner = evaluated.find(
        (entry) => entry.candidate.sourceUrl === best!.candidate.sourceUrl,
      );
      if (winner) winner.selected = true;

      // Anything that only cleared the relaxed bar of a final retry is handed
      // back flagged. It is a better outcome than an empty cell, but it is a
      // judgement somebody should look at rather than a confident answer.
      const marginal =
        effort.acceptMarginal && best.qualityScore < MINIMUM_QUALITY_THRESHOLD;

      return {
        status: 'succeeded',
        needsReview: marginal || undefined,
        reviewReason: marginal
          ? `Only a low-quality image could be found (score ${best.qualityScore.toFixed(2)}). ` +
            'It is here so the row is not empty, but check it before you use it.'
          : undefined,
        kind: best.candidate.provider === 'spreadsheet' ? 'USER_PROVIDED' : 'REAL',
        render,
        enrichment,
        facts,
        provider: best.candidate.provider,
        sourceUrl: best.candidate.sourceUrl,
        matchScore: best.matchScore,
        qualityScore: best.qualityScore,
        alternatives: collectAlternatives(evaluated, best.candidate.sourceUrl),
        candidates: evaluated,
        log,
      };
    } catch (error) {
      // Deferring the render moves its failures here, after the search has
      // already committed. Falling through to generation is better than failing
      // the product outright over one unreadable file.
      const message = error instanceof Error ? error.message : String(error);
      const entry = evaluated.find(
        (candidate) => candidate.candidate.sourceUrl === best!.candidate.sourceUrl,
      );
      if (entry) {
        entry.rejected = true;
        entry.rejectedReason = `Could not be rendered: ${message}`;
      }
      log.push(`Rendering ${hostOf(best.candidate.sourceUrl)} failed: ${message}`);
      best = null;
    }
  }

  // --- 5. Workflow B: generate --------------------------------------------
  // What actually happened in Workflow A, so a failure says which step came up
  // empty rather than only that the fallback was unavailable.
  const searchSummary = summariseSearch({
    evaluated,
    identified: Boolean(facts),
    searchedWeb,
    webAvailable: webSearchConfigured(),
    webErrors,
  });

  if (!options.allowAiGeneration) {
    return {
      status: 'failed',
      reason:
        `${searchSummary} No image was invented to fill the gap, because an ` +
        'invented one would not be this product. Turn on AI generation for the ' +
        'batch if a representative picture is better than an empty cell.',
      enrichment,
      facts,
      candidates: evaluated,
      log,
    };
  }

  const generator = generationProvider();
  if (!generator) {
    return {
      status: 'failed',
      reason:
        `${searchSummary} No AI image provider is configured either, so there was no ` +
        'fallback. Set OPENAI_API_KEY on the server to enable web image search and ' +
        'generated images.',
      enrichment,
      facts,
      candidates: evaluated,
      log,
    };
  }

  try {
    log.push(`Generating a product image with ${generator.name}`);
    const generated = await generator.generate({ prompt: enrichment.generationPrompt });

    // Look at what came back before shipping it. An image model asked for a
    // body wash has returned a box of tea — correctly named, correctly labelled
    // "AI generated", and entirely the wrong product. Nothing else in the
    // pipeline would have noticed, because a generated image is the one image
    // never scored against anything.
    const check = await verifyProductImage({
      buffer: generated.buffer,
      title: enrichment.canonicalTitle,
      brand: enrichment.brand,
      category: enrichment.category,
      strict: true,
    });
    if (check.verdict === "mismatch") {
      log.push(`Discarded the generated image: ${check.reason}`);
      return {
        status: 'failed',
        reason:
          `${searchSummary} A replacement image was generated, but it came back showing ` +
          `${check.shown || 'a different product'}, so it was discarded rather than filed ` +
          'under this barcode.',
        enrichment,
        facts,
        candidates: evaluated,
        log,
      };
    }
    if (check.verdict === 'unknown') log.push(`Generated image unverified: ${check.reason}`);

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
      facts,
      provider: `${generated.provider}:${generated.model}`,
      matchScore: 0,
      // A generated image is clean by construction, but it is not the real
      // product, so it never scores as highly as a verified photograph.
      qualityScore: 0.7,
      // Nothing to offer: generation only runs once every real photograph has
      // already been rejected, so the runners-up are the ones that failed.
      alternatives: [],
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
      facts,
      candidates: evaluated,
      log,
    };
  }
}

/**
 * One sentence describing how Workflow A ended.
 *
 * "No image found" is not a diagnosis. Knowing whether nothing was returned at
 * all, or plenty was returned and rejected, is the difference between "add a
 * search provider" and "the matching is too strict for this catalogue".
 */
interface SearchSummaryInput {
  evaluated: EvaluatedCandidate[];
  identified: boolean;
  searchedWeb: boolean;
  /** Whether a web image search provider is configured at all. */
  webAvailable: boolean;
  /** Errors the web tier reported, if it ran. */
  webErrors: Array<{ provider: string; message: string }>;
}

/**
 * One sentence describing how Workflow A ended.
 *
 * "No image found" is not a diagnosis, and neither is the reason the *first*
 * tier gave. A barcode database handing back a dead link is completely normal —
 * those records hotlink retailer CDNs that expire — and it only becomes a
 * failure when the tier behind it also comes up empty. Reporting the 404 alone
 * blames the barcode for something that is usually the search tier being
 * unconfigured or broken, which is the difference between "this product is
 * obscure" and "fix your server".
 */
function summariseSearch(input: SearchSummaryInput): string {
  const { evaluated, identified, searchedWeb, webAvailable, webErrors } = input;

  const webNote = !webAvailable
    ? ' No web image search is configured on this server, so there was nowhere else to look — set OPENAI_API_KEY to enable it.'
    : webErrors.length > 0
      ? ` The web image search also failed (${webErrors[0]?.provider}: ${webErrors[0]?.message}).`
      : searchedWeb
        ? ' The web image search found nothing either.'
        : '';

  if (evaluated.length === 0) {
    const head = identified
      ? 'The product was identified, but no image source returned a candidate for it.'
      : 'No product database recognised this item.';
    return head + webNote;
  }

  const rejected = evaluated.filter((entry) => entry.rejected);
  const reason = rejected[0]?.rejectedReason;

  return (
    `Found ${evaluated.length} candidate image(s) but rejected ${rejected.length}` +
    (reason ? ` (first: ${reason.toLowerCase()})` : '') +
    '.' +
    webNote
  );
}

// ---------------------------------------------------------------------------
// Candidate evaluation
// ---------------------------------------------------------------------------

interface Winner {
  candidate: SearchCandidate;
  matchScore: number;
  qualityScore: number;
  /**
   * The downloaded original, not a rendered image.
   *
   * Rendering here would mean rendering every candidate that passes scoring and
   * discarding all but one — five full pipelines per product, four of them for
   * an image nobody will ever see. Scoring already decides the winner from the
   * analysis pass, which is far cheaper, so the render waits until there is
   * exactly one image left to render.
   */
  source: Buffer | null;
  /** Set when this candidate was served from the cache and needs no work. */
  cached: RenderResult | null;
  /** How likely this is to show the packaging currently on shelves, 0-1. */
  recencyScore: number;
}

interface EvaluateArgs {
  candidates: SearchCandidate[];
  searchContext: SearchContext;
  product: ProcessInput['product'];
  options: RenderOptions;
  evaluated: EvaluatedCandidate[];
  log: string[];
  maxDownloads: number;
  /** Floor a downloaded image must clear, which the retry ladder lowers. */
  minQuality: number;
  incumbent?: Winner | null;
}

/**
 * How good a candidate is, all things considered.
 *
 * Identity dominates, because the wrong product photographed beautifully and
 * published this morning is still the wrong product. Quality comes next.
 * Recency is a tiebreaker with real weight but no veto: it decides between two
 * acceptable pictures of the right thing, which is exactly the case where an
 * archive's decade-old photograph used to win simply by being looked at first.
 */
function overallScore(match: number, quality: number, recency: number): number {
  return match * 0.6 + quality * 0.25 + recency * 0.15;
}

/**
 * The runners-up worth offering as a different answer.
 *
 * Only candidates that were downloaded and scored — a candidate that never got
 * that far has an unverified guess for a match score, and offering it would be
 * offering a URL rather than a photograph. Rejected ones are excluded for the
 * same reason: they failed a check that has not stopped applying.
 *
 * Near-duplicates of the winner and of each other collapse, so two entries mean
 * two pictures.
 */
export function collectAlternatives(
  evaluated: EvaluatedCandidate[],
  winnerUrl: string,
): Alternative[] {
  const seen = new Set([canonicalImageKey(winnerUrl)]);
  const alternatives: Alternative[] = [];

  const contenders = evaluated
    .filter((entry) => !entry.rejected && !entry.selected && entry.qualityScore > 0)
    .sort(
      (a, b) =>
        overallScore(b.matchScore, b.qualityScore, 0) -
        overallScore(a.matchScore, a.qualityScore, 0),
    );

  for (const entry of contenders) {
    const key = canonicalImageKey(entry.candidate.sourceUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    alternatives.push({
      sourceUrl: entry.candidate.sourceUrl,
      provider: entry.candidate.provider,
      matchScore: entry.matchScore,
      qualityScore: entry.qualityScore,
    });
    if (alternatives.length >= MAX_ALTERNATIVES) break;
  }

  return alternatives;
}

/**
 * Score, download, and render candidates, returning the best one found —
 * including the incumbent, so a later tier only wins if it is genuinely better.
 */
async function evaluateCandidates(args: EvaluateArgs): Promise<Winner | null> {
  const { candidates, searchContext, product, evaluated, log } = args;

  if (candidates.length === 0) return args.incumbent ?? null;

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      assessment: scoreMatch({
        candidate,
        enrichment: searchContext.enrichment,
        upc: product.upc,
        model: searchContext.model,
      }),
    }))
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
    (entry) => !entry.assessment.rejected && entry.assessment.score >= MINIMUM_MATCH_THRESHOLD,
  );

  let best = args.incumbent ?? null;
  let downloads = 0;

  /**
   * Candidates are weighed a few at a time rather than one after another.
   *
   * Each one is a download from a different host followed by an image decode,
   * and none of them informs the next — the ranking that decides which to try
   * was fixed before any of this. In sequence the product waits for the sum;
   * in a wave it waits for the slowest of three.
   *
   * Waves rather than all at once, because the early stop is worth keeping: the
   * first candidate is usually the manufacturer's own photograph, and when it
   * is both a confident match and a good picture there is no reason to have
   * fetched anything else.
   */
  const WAVE = 3;

  for (let offset = 0; offset < viable.length; offset += WAVE) {
    if (downloads >= args.maxDownloads) break;
    if (best && best.matchScore >= CONFIDENT_MATCH_THRESHOLD && best.qualityScore >= 0.75) break;

    const wave = viable.slice(offset, offset + Math.min(WAVE, args.maxDownloads - downloads));

    // Anything already rendered from this exact URL, at these exact settings,
    // needs no network and no pixels — it was downloaded, scored, verified and
    // rendered the last time, and none of those answers depend on anything that
    // has changed since. This is what makes re-running a barcode instant rather
    // than merely quick.
    const remembered = wave
      .map((entry) => ({ entry, hit: renderedImages.get(renderKey(entry.candidate.sourceUrl, args.options)) }))
      .find((row) => row.hit);

    if (remembered?.hit) {
      const { candidate, assessment } = remembered.entry;
      const recency = scoreRecency({
        sourceUrl: candidate.sourceUrl,
        pageUrl: candidate.pageUrl,
      });
      const combined = overallScore(assessment.score, remembered.hit.qualityScore, recency.score);
      const bestCombined = best
        ? overallScore(best.matchScore, best.qualityScore, best.recencyScore)
        : -1;
      if (combined > bestCombined) {
        best = {
          candidate,
          matchScore: assessment.score,
          qualityScore: remembered.hit.qualityScore,
          source: null,
          cached: remembered.hit.render,
          recencyScore: recency.score,
        };
      }
      evaluated.push({
        candidate,
        matchScore: assessment.score,
        qualityScore: remembered.hit.qualityScore,
        rejected: false,
        selected: false,
      });
      log.push(`Reused the rendered image for ${hostOf(candidate.sourceUrl)}`);
      continue;
    }

    downloads += wave.length;

    const results = await Promise.all(
      wave.map(async ({ candidate, assessment }) => {
        try {
          const { buffer, lastModified, usedUrl } = await downloadAndPrepare(candidate.sourceUrl);
          const analysis = await analyseImage(buffer);
          // Provenance follows the bytes: the export and the audit trail should
          // name the URL that actually served the image, not the one we asked
          // about first.
          const served = usedUrl === candidate.sourceUrl
            ? candidate
            : { ...candidate, sourceUrl: usedUrl };
          return { candidate: served, assessment, source: buffer, lastModified, analysis, error: null };
        } catch (error) {
          return {
            candidate,
            assessment,
            source: null,
            lastModified: null,
            analysis: null,
            error,
          };
        }
      }),
    );

    // Scored in ranking order, not completion order, so which image wins never
    // depends on which host happened to answer first.
    for (const { candidate, assessment, source, lastModified, analysis, error } of results) {
      if (error || !source || !analysis) {
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
        continue;
      }

      const quality = scoreQuality({
        width: analysis.width,
        height: analysis.height,
        bytes: source.byteLength,
        borderVariance: analysis.borderVariance,
        foregroundRatio: analysis.foregroundRatio,
        detail: analysis.detail,
        hasAlpha: analysis.hasAlpha,
        overlayShare: analysis.overlayShare,
      });

      if (quality.rejected || quality.score < args.minQuality) {
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

      const recency = scoreRecency({
        sourceUrl: candidate.sourceUrl,
        pageUrl: candidate.pageUrl,
        lastModified,
      });
      const combined = overallScore(assessment.score, quality.score, recency.score);
      const bestCombined = best
        ? overallScore(best.matchScore, best.qualityScore, best.recencyScore)
        : -1;

      if (combined > bestCombined) {
        best = {
          candidate,
          matchScore: assessment.score,
          qualityScore: quality.score,
          source,
          cached: null,
          recencyScore: recency.score,
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
        `Accepted ${hostOf(candidate.sourceUrl)} — match ${assessment.score.toFixed(2)}, quality ${quality.score.toFixed(2)}, recency ${recency.score.toFixed(2)} (${recency.reason}; ${quality.notes.join(', ') || 'no notes'})`,
      );
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toEnrichment(product: ProcessInput['product']): EnrichmentInput {
  return {
    name: product.name,
    brand: product.brand,
    model: product.model,
    upc: product.upc,
    sku: product.sku,
    description: product.description,
    specifications: product.specifications,
    category: product.category,
  };
}

const ACCEPTED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/tiff',
]);

/**
 * Fetch a candidate, asking for the full-size version first.
 *
 * A barcode database stores a thumbnail because that is what its own page
 * needed, and the size is in the URL. Taking it at face value is how a product
 * with perfectly good photography behind it gets reported as having none: a
 * 185x400 render of a granola bar is below the resolution floor, so it is
 * rejected, and so is every other thumbnail of the same picture.
 *
 * The larger URL is a guess, so it is only ever tried *before* the original and
 * never instead of it. A host that has changed its scheme costs one wasted
 * request; the original is still fetched and the product still succeeds.
 */
async function downloadAndPrepare(
  url: string,
): Promise<{ buffer: Buffer; lastModified: string | null; usedUrl: string }> {
  const attempts = [...largerVariants(url), url];
  let lastError: unknown;

  for (const attempt of attempts) {
    try {
      return await downloadOne(attempt);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function downloadOne(
  url: string,
): Promise<{ buffer: Buffer; lastModified: string | null; usedUrl: string }> {
  const { buffer, contentType, lastModified } = await fetchBinary(url, {
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

  return { buffer, lastModified, usedUrl: url };
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
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
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
