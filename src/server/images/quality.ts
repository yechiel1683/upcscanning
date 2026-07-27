import type { ProductEnrichment, SearchCandidate } from '@/lib/types';

/**
 * Candidate evaluation.
 *
 * Two independent judgements, kept separate on purpose:
 *
 *  - matchScore   "is this the right product?"  — text signals, before download
 *  - qualityScore "is this a usable photo?"     — pixel signals, after download
 *
 * A gorgeous photo of the wrong item is worse than a mediocre photo of the
 * right one, so the pipeline gates on match first and only then ranks by
 * quality.
 */

// ---------------------------------------------------------------------------
// Match scoring (pre-download)
// ---------------------------------------------------------------------------

const JUNK_URL_PATTERNS = [
  /\/(thumb|thumbnail|icon|sprite|placeholder|no[-_]?image|noimage|default)[-_./]/i,
  /(logo|banner|badge|avatar|favicon)\./i,
  /\.(svg|gif|bmp|tiff?)($|\?)/i,
  /data:image/i,
];

const LOW_RES_HINTS = [/_\d{2}x\d{2}\./, /[-_](50|75|100|120|150)x(50|75|100|120|150)[-_.]/];

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 1),
  );
}

export interface MatchInput {
  candidate: SearchCandidate;
  enrichment: ProductEnrichment;
  upc?: string | null;
  model?: string | null;
}

export interface MatchAssessment {
  score: number;
  rejected: boolean;
  reason?: string;
}

export function scoreMatch(input: MatchInput): MatchAssessment {
  const { candidate, enrichment } = input;
  const url = candidate.sourceUrl;

  for (const pattern of JUNK_URL_PATTERNS) {
    if (pattern.test(url)) {
      return { score: 0, rejected: true, reason: 'URL looks like an icon, sprite, or placeholder' };
    }
  }

  // Dimensions, when the provider reported them, are a hard gate: a 100px
  // thumbnail can never become a 1600px catalog image.
  if (candidate.width && candidate.height) {
    if (candidate.width < 300 || candidate.height < 300) {
      return {
        score: 0,
        rejected: true,
        reason: `Too small (${candidate.width}x${candidate.height})`,
      };
    }
    const aspect = candidate.width / candidate.height;
    if (aspect > 3 || aspect < 1 / 3) {
      return { score: 0, rejected: true, reason: 'Extreme aspect ratio, likely a banner' };
    }
  } else if (LOW_RES_HINTS.some((p) => p.test(url))) {
    return { score: 0, rejected: true, reason: 'URL indicates a low-resolution variant' };
  }

  // Start from how much the provider itself can be trusted.
  let score = candidate.providerConfidence * 0.55;

  const haystack = `${candidate.title ?? ''} ${candidate.pageUrl ?? ''} ${url}`.toLowerCase();
  const haystackTokens = tokenise(haystack);

  // A barcode appearing in the result is near-proof of an exact match.
  if (input.upc && haystack.includes(input.upc)) score += 0.25;

  // A model number is the next strongest signal.
  const model = (input.model ?? enrichment.model)?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (model && model.length >= 4) {
    const normalisedHaystack = haystack.replace(/[^a-z0-9]/g, '');
    if (normalisedHaystack.includes(model)) score += 0.2;
  }

  // Required keywords: proportion present.
  if (enrichment.requiredKeywords.length > 0) {
    const present = enrichment.requiredKeywords.filter((k) => haystack.includes(k)).length;
    const ratio = present / enrichment.requiredKeywords.length;
    score += ratio * 0.15;
    if (ratio === 0 && candidate.providerConfidence < 0.85) {
      return {
        score: 0,
        rejected: true,
        reason: 'No brand or model keyword present in the result',
      };
    }
  }

  // Title overlap with the canonical product title.
  if (candidate.title) {
    const titleTokens = tokenise(candidate.title);
    const productTokens = tokenise(enrichment.canonicalTitle);
    if (productTokens.size > 0) {
      let overlap = 0;
      for (const token of productTokens) if (titleTokens.has(token)) overlap += 1;
      score += (overlap / productTokens.size) * 0.15;
    }
  }

  // Negative keywords indicate an accessory or a part for the product.
  const hit = enrichment.negativeKeywords.find((keyword) => {
    if (keyword.includes(' ')) return haystack.includes(keyword);
    return haystackTokens.has(keyword);
  });
  if (hit) {
    // Trusted barcode sources are exact by construction; a stray word in the
    // title should not override a GTIN lookup.
    if (candidate.providerConfidence >= 0.9) score -= 0.05;
    else {
      return { score: 0, rejected: true, reason: `Looks like an accessory ("${hit}")` };
    }
  }

  return { score: Math.max(0, Math.min(1, score)), rejected: false };
}

// ---------------------------------------------------------------------------
// Quality scoring (post-download)
// ---------------------------------------------------------------------------

export interface QualityInput {
  width: number;
  height: number;
  bytes: number;
  /** Border uniformity from the background analysis, if it ran. */
  borderVariance?: number;
  foregroundRatio?: number;
  /** Mean absolute deviation of luminance; a proxy for detail/sharpness. */
  detail?: number;
  hasAlpha?: boolean;
}

export interface QualityAssessment {
  score: number;
  rejected: boolean;
  reason?: string;
  notes: string[];
}

export function scoreQuality(input: QualityInput): QualityAssessment {
  const notes: string[] = [];
  const shortSide = Math.min(input.width, input.height);
  const longSide = Math.max(input.width, input.height);

  if (shortSide < 250) {
    return {
      score: 0,
      rejected: true,
      reason: `Resolution too low (${input.width}x${input.height})`,
      notes,
    };
  }

  const aspect = longSide / Math.max(shortSide, 1);
  if (aspect > 3) {
    return { score: 0, rejected: true, reason: 'Extreme aspect ratio', notes };
  }

  // A byte count this small for the pixel count means a heavily compressed or
  // near-blank image.
  const bitsPerPixel = (input.bytes * 8) / (input.width * input.height);
  if (bitsPerPixel < 0.04 && !input.hasAlpha) {
    return { score: 0, rejected: true, reason: 'Image appears blank or over-compressed', notes };
  }

  let score = 0;

  // Resolution — the single biggest driver of a usable catalog image.
  if (shortSide >= 1600) { score += 0.4; notes.push('high resolution'); }
  else if (shortSide >= 1000) { score += 0.34; }
  else if (shortSide >= 700) { score += 0.26; }
  else if (shortSide >= 500) { score += 0.18; }
  else { score += 0.08; notes.push('will upscale below target size'); }

  // Squareness — catalog grids want square images, so less cropping is better.
  if (aspect <= 1.1) { score += 0.18; notes.push('square'); }
  else if (aspect <= 1.4) score += 0.12;
  else if (aspect <= 2) score += 0.06;

  // Clean backdrop.
  if (input.borderVariance !== undefined) {
    if (input.borderVariance < 120) { score += 0.22; notes.push('clean background'); }
    else if (input.borderVariance < 600) score += 0.12;
    else notes.push('busy background');
  } else {
    score += 0.1;
  }

  // Subject fills a sensible portion of the frame.
  if (input.foregroundRatio !== undefined) {
    if (input.foregroundRatio >= 0.15 && input.foregroundRatio <= 0.8) {
      score += 0.12;
      notes.push('well framed');
    } else if (input.foregroundRatio > 0.9) {
      notes.push('subject is cropped tight or background not detected');
    } else if (input.foregroundRatio < 0.05) {
      notes.push('subject is very small in frame');
    }
  } else {
    score += 0.06;
  }

  // Detail/contrast.
  if (input.detail !== undefined) {
    if (input.detail > 18) { score += 0.08; }
    else if (input.detail < 4) { notes.push('very low contrast'); score -= 0.05; }
  }

  if (input.hasAlpha) notes.push('already has transparency');

  return { score: Math.max(0, Math.min(1, score)), rejected: false, notes };
}

/**
 * Threshold above which a candidate is accepted without looking at the rest.
 * Set high enough that a barcode hit ends the search but a lucky web result
 * still gets compared against its peers.
 */
export const CONFIDENT_MATCH_THRESHOLD = 0.82;

/** Below this, a candidate is not worth downloading at all. */
export const MINIMUM_MATCH_THRESHOLD = 0.35;

/** Below this, a downloaded image is rejected and we move to the next candidate. */
export const MINIMUM_QUALITY_THRESHOLD = 0.3;
