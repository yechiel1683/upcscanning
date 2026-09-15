import { NextResponse } from 'next/server';

import { checkRate, type RateLimitRule } from '@/server/lib/rate-limit-inbound';
import { rateLimitKey } from './client-ip';

/**
 * Route-level rate limiting.
 *
 * Handlers call `limit(...)` first and return whatever it gives back when it
 * gives back anything; `null` means carry on. Explicit rather than middleware,
 * because the right ceiling is a property of what the route *costs* — a login
 * attempt costs a bcrypt hash, a guest batch costs a hundred image pipelines —
 * and burying that in a table away from the handler is how routes get added
 * without one.
 */

/**
 * The ceilings, named by what they protect.
 *
 * Set for a single web process. Two containers means two limiters and twice
 * the effective allowance, which is why the money ceiling in
 * `guest/budget.ts` exists underneath these and does not care how many
 * processes are running.
 */
export const LIMITS = {
  /**
   * The expensive one. Each call accepts up to a hundred products, and every
   * product spends on search, verification and rendering. Someone genuinely
   * evaluating the product runs a handful of batches; nobody legitimate runs
   * six in an hour.
   */
  guestBatch: { limit: 5, windowMs: 60 * 60_000 },

  /**
   * Starting a session is cheap in itself, but each one carries a fresh image
   * allowance — so handing them out without limit hands out the allowance
   * without limit.
   */
  guestSession: { limit: 20, windowMs: 60 * 60_000 },

  /** Parsing a spreadsheet is CPU, not API spend, but it is not free either. */
  uploadPreview: { limit: 30, windowMs: 60 * 60_000 },

  /**
   * Password attempts. Tight enough to make credential stuffing useless,
   * loose enough to survive somebody genuinely mistyping.
   */
  login: { limit: 10, windowMs: 15 * 60_000 },

  /** Account creation, per address, to stop allowance farming. */
  register: { limit: 5, windowMs: 60 * 60_000 },

  /**
   * The setup checks each make a real API call against the configured key.
   * They are meant to be pressed by an operator a few times, not polled.
   */
  setupCheck: { limit: 10, windowMs: 10 * 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type LimitName = keyof typeof LIMITS;

/**
 * Apply a named limit to this request.
 *
 * Returns a 429 to return, or null to continue. The response carries the
 * standard headers so a well-behaved client can back off on its own instead of
 * retrying into the wall.
 */
export function limit(request: Request, name: LimitName): NextResponse | null {
  const rule = LIMITS[name];
  const verdict = checkRate(rateLimitKey(request, name), rule);

  if (verdict.allowed) return null;

  const minutes = Math.ceil(verdict.retryAfterSeconds / 60);
  const wait =
    verdict.retryAfterSeconds < 90
      ? `${verdict.retryAfterSeconds} seconds`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`;

  return NextResponse.json(
    {
      error: `That is more requests than this endpoint allows. Try again in ${wait}.`,
      retryAfterSeconds: verdict.retryAfterSeconds,
    },
    {
      status: 429,
      headers: {
        'retry-after': String(verdict.retryAfterSeconds),
        'x-ratelimit-limit': String(verdict.limit),
        'x-ratelimit-remaining': '0',
      },
    },
  );
}

/**
 * Reject a state-changing request that a different site caused the browser to
 * send.
 *
 * Cookies are attached by the browser to *any* request to this origin,
 * including one triggered by a form on somebody else's page. `SameSite=Lax`
 * already blocks the common shapes, but it is one flag on one cookie, it does
 * not separate this app from anything else on the same registrable domain, and
 * it has carried browser-specific exceptions before. A second, independent
 * check costs a string comparison.
 *
 * Bearer tokens are deliberately exempt, and that is not a hole: a browser
 * never attaches an Authorization header on its own, so a request carrying one
 * was written deliberately by whoever holds the key. Applying the check to API
 * clients would break every legitimate one — none of them sends an Origin —
 * while protecting nothing.
 */
export function sameOrigin(request: Request): NextResponse | null {
  const method = request.method.toUpperCase();
  // GET/HEAD must not change anything, so there is nothing to forge.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  // Authenticated by key, not by cookie: not reachable through a victim's
  // browser, so not a cross-site request forgery risk.
  if (request.headers.get('authorization')?.toLowerCase().startsWith('bearer ')) return null;

  const origin = request.headers.get('origin');
  const target = new URL(request.url).host;

  if (origin) {
    let sender: string;
    try {
      sender = new URL(origin).host;
    } catch {
      return csrfRefusal();
    }
    return sender === target ? null : csrfRefusal();
  }

  // No Origin. Browsers send it on every cross-origin state-changing request,
  // so its absence usually means a non-browser client — but treating "absent"
  // as "fine" would make the check opt-out for anyone who can suppress a
  // header. Referer is the fallback; with neither, refuse.
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).host === target ? null : csrfRefusal();
    } catch {
      return csrfRefusal();
    }
  }

  return csrfRefusal();
}

function csrfRefusal(): NextResponse {
  return NextResponse.json(
    {
      error:
        'This request did not come from the UPC Scanning site. If you are using the ' +
        'API directly, authenticate with an API key instead of a session cookie.',
    },
    { status: 403 },
  );
}
