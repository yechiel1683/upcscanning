import { env } from '@/lib/env';

/**
 * A hard daily ceiling on what the free trial may spend.
 *
 * Rate limiting is about traffic; this is about money, and they fail
 * differently. A per-IP limit is per process and per address — two containers
 * double it, and a botnet sidesteps it entirely by never reusing an address.
 * Neither of those matters here: this counts images actually processed, across
 * every visitor, against one number. When that number is reached the trial
 * closes for the day and the bill stops, whatever the traffic looks like.
 *
 * The distinction that makes it useful: this is a *reservation*, taken before
 * the work runs, not a tally read afterwards. A counter incremented on
 * completion is always behind by however many batches are in flight, which is
 * exactly the window a flood exploits.
 *
 * Deliberately not persisted. A restart resets the day, which is the wrong
 * direction to be wrong in — but the alternative is a database dependency on
 * the one path that exists to work without a database, and the per-IP limits
 * still apply underneath. When Postgres is attached this should move there.
 */

interface DayLedger {
  /** UTC date key, so the reset is not tied to where the server happens to be. */
  day: string;
  /** Images reserved today, whether or not they finished. */
  reserved: number;
}

let ledger: DayLedger = { day: '', reserved: 0 };

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function current(now: number): DayLedger {
  const day = today(now);
  if (ledger.day !== day) ledger = { day, reserved: 0 };
  return ledger;
}

export interface BudgetVerdict {
  allowed: boolean;
  /** Images still available today. */
  remaining: number;
  limit: number;
  /** Set when refused, in the language of someone who just wanted to try it. */
  message?: string;
}

/**
 * Claim `count` images against today's allowance before doing the work.
 *
 * All-or-nothing on purpose. Partially admitting a batch would mean silently
 * processing the first forty rows of a hundred-row upload and reporting the
 * rest as failures, which looks like the product being broken rather than the
 * trial being full.
 */
export function reserveGuestImages(count: number, now = Date.now()): BudgetVerdict {
  const limitValue = env().GUEST_DAILY_IMAGE_LIMIT;
  const day = current(now);

  // Zero disables the trial outright, which is the switch to reach for if this
  // ever needs to be closed in a hurry.
  if (limitValue <= 0) {
    return {
      allowed: false,
      remaining: 0,
      limit: 0,
      message:
        'The free trial is switched off at the moment. Create an account to process ' +
        'your list.',
    };
  }

  const remaining = Math.max(0, limitValue - day.reserved);

  if (count > remaining) {
    return {
      allowed: false,
      remaining,
      limit: limitValue,
      message:
        remaining === 0
          ? 'The free trial has reached its limit for today. It resets at midnight UTC — ' +
            'or create an account to carry on now.'
          : `The free trial has ${remaining} image${remaining === 1 ? '' : 's'} left today ` +
            `and this list needs ${count}. Try a shorter list, or create an account.`,
    };
  }

  day.reserved += count;
  return { allowed: true, remaining: remaining - count, limit: limitValue };
}

/**
 * Hand back images that were reserved but never processed.
 *
 * A batch that fails to start has not cost anything, and keeping its
 * reservation would close the trial early for everyone else.
 */
export function releaseGuestImages(count: number, now = Date.now()): void {
  const day = current(now);
  day.reserved = Math.max(0, day.reserved - count);
}

/** What the trial has spent today, for the status endpoint and diagnostics. */
export function guestBudgetStatus(now = Date.now()): {
  used: number;
  limit: number;
  remaining: number;
  exhausted: boolean;
} {
  const limitValue = env().GUEST_DAILY_IMAGE_LIMIT;
  const day = current(now);
  const remaining = Math.max(0, limitValue - day.reserved);
  return {
    used: day.reserved,
    limit: limitValue,
    remaining,
    exhausted: limitValue > 0 && remaining === 0,
  };
}

/** Test hook: start the day over. */
export function resetGuestBudget(): void {
  ledger = { day: '', reserved: 0 };
}
