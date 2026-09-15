/**
 * What is for sale.
 *
 * Credit packs rather than subscriptions: a distributor's work is lumpy. They
 * onboard four hundred products in a week and then nothing for a month, and
 * charging them monthly for the quiet weeks is how a useful tool becomes a
 * subscription somebody cancels. One credit is one image that came back.
 *
 * Defined here rather than in Stripe so the app knows what it sells without a
 * network call, and so the price a customer was charged can be checked against
 * the price we meant to charge. Stripe holds the money; this holds the truth
 * about what a pack contains.
 *
 * Prices are in cents. Nothing about money is ever a float.
 */

export interface Pack {
  id: string;
  name: string;
  credits: number;
  /** Cents. */
  amount: number;
  currency: 'usd';
  /** Shown on the pricing page under the name. */
  blurb: string;
}

export const PACKS: Pack[] = [
  {
    id: 'starter-250',
    name: 'Starter',
    credits: 250,
    amount: 2900,
    currency: 'usd',
    blurb: 'A single supplier list, or a month of small updates.',
  },
  {
    id: 'standard-1000',
    name: 'Standard',
    credits: 1000,
    amount: 9900,
    currency: 'usd',
    blurb: 'A full catalog refresh. The usual choice.',
  },
  {
    id: 'bulk-5000',
    name: 'Bulk',
    credits: 5000,
    amount: 39900,
    currency: 'usd',
    blurb: 'Several catalogs, or one very large one.',
  },
];

export function findPack(id: string): Pack | null {
  return PACKS.find((pack) => pack.id === id) ?? null;
}

/** Price per image in cents, for the pricing page's "works out at" line. */
export function centsPerImage(pack: Pack): number {
  return pack.amount / pack.credits;
}

/** "$29" or "$3.50" — trailing zeroes dropped, because $29.00 reads as noise. */
export function formatPrice(cents: number, currency = 'usd'): string {
  const symbol = currency === 'usd' ? '$' : '';
  const whole = cents / 100;
  return Number.isInteger(whole) ? `${symbol}${whole}` : `${symbol}${whole.toFixed(2)}`;
}
