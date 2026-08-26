import { describe, expect, it } from 'vitest';

import { collectAlternatives, type EvaluatedCandidate } from '@/server/pipeline/process-product';

/**
 * When several plausible photographs of one product turn up, the ranking picks
 * the most accurate. That is a score, though, and when the scores are close the
 * person filling the catalog judges better than the number does — so an
 * uncertain row offers the runner-up rather than only accept-or-empty.
 *
 * The list has to be worth showing. Two entries must mean two pictures, not one
 * picture at two sizes; and everything offered must have been downloaded and
 * cleared, because offering a candidate that failed its checks is offering a
 * wrong answer with a button attached.
 */

function candidate(
  sourceUrl: string,
  matchScore: number,
  qualityScore: number,
  extra: Partial<EvaluatedCandidate> = {},
): EvaluatedCandidate {
  return {
    candidate: { provider: 'test', sourceUrl, providerConfidence: 0.8 },
    matchScore,
    qualityScore,
    rejected: false,
    selected: false,
    ...extra,
  };
}

const WINNER = 'https://a.example/winner.jpg';

describe('collectAlternatives', () => {
  it('offers the runners-up, best first', () => {
    const alternatives = collectAlternatives(
      [
        candidate(WINNER, 0.9, 0.9, { selected: true }),
        candidate('https://a.example/weak.jpg', 0.4, 0.5),
        candidate('https://a.example/strong.jpg', 0.8, 0.7),
      ],
      WINNER,
    );

    expect(alternatives.map((option) => option.sourceUrl)).toEqual([
      'https://a.example/strong.jpg',
      'https://a.example/weak.jpg',
    ]);
  });

  it('never offers the image already chosen', () => {
    const alternatives = collectAlternatives(
      [candidate(WINNER, 0.9, 0.9, { selected: true })],
      WINNER,
    );
    expect(alternatives).toEqual([]);
  });

  it('does not offer the winner back under a different size', () => {
    // The same photograph reaches this pipeline from several providers at
    // several sizes. "Use this instead" pointing at the picture already on
    // screen is a broken button, not a choice.
    const alternatives = collectAlternatives(
      [
        candidate(
          'https://images.openfoodfacts.org/p/1/front_en.4.full.jpg',
          0.9,
          0.9,
          { selected: true },
        ),
        candidate('https://images.openfoodfacts.org/p/1/front_en.4.400.jpg', 0.85, 0.6),
      ],
      'https://images.openfoodfacts.org/p/1/front_en.4.full.jpg',
    );
    expect(alternatives).toEqual([]);
  });

  it('collapses two contenders that are the same picture', () => {
    const alternatives = collectAlternatives(
      [
        candidate(WINNER, 0.9, 0.9, { selected: true }),
        candidate('https://m.media-amazon.com/images/I/71abc._SL160_.jpg', 0.8, 0.7),
        candidate('https://m.media-amazon.com/images/I/71abc.jpg', 0.8, 0.75),
      ],
      WINNER,
    );
    expect(alternatives).toHaveLength(1);
  });

  it('leaves out anything that failed a check', () => {
    // A rejected candidate failed a test that has not stopped applying. Putting
    // it behind a button makes the wrong product one click away.
    const alternatives = collectAlternatives(
      [
        candidate(WINNER, 0.9, 0.9, { selected: true }),
        candidate('https://a.example/mismatch.jpg', 0.95, 0.9, {
          rejected: true,
          rejectedReason: 'Shows a different product',
        }),
      ],
      WINNER,
    );
    expect(alternatives).toEqual([]);
  });

  it('leaves out anything that was never downloaded', () => {
    // A candidate that never got fetched has a guessed match score from its
    // title and no quality score at all. Offering it would be offering a URL.
    const alternatives = collectAlternatives(
      [
        candidate(WINNER, 0.9, 0.9, { selected: true }),
        candidate('https://a.example/unseen.jpg', 0.7, 0),
      ],
      WINNER,
    );
    expect(alternatives).toEqual([]);
  });

  it('stops at two, because a choice is not a search', () => {
    const alternatives = collectAlternatives(
      [
        candidate(WINNER, 0.9, 0.9, { selected: true }),
        candidate('https://a.example/1.jpg', 0.8, 0.7),
        candidate('https://a.example/2.jpg', 0.75, 0.7),
        candidate('https://a.example/3.jpg', 0.7, 0.7),
        candidate('https://a.example/4.jpg', 0.65, 0.7),
      ],
      WINNER,
    );
    expect(alternatives).toHaveLength(2);
  });
});
