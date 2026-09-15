import { env } from '@/lib/env';

/**
 * Working out who is actually calling.
 *
 * This is the load-bearing part of any rate limit, and the obvious reading of
 * `x-forwarded-for` gets it exactly backwards. The header is a trail:
 *
 *     x-forwarded-for: <client>, <proxy 1>, <proxy 2>
 *
 * Each proxy *appends* the address it received the request from. The leftmost
 * entry is therefore the only one nobody trustworthy wrote — a caller can send
 * `x-forwarded-for: 1.2.3.4` themselves, and every proxy will politely append
 * to that lie. Reading the leftmost entry means an attacker changes their
 * apparent identity per request and the rate limit does nothing at all.
 *
 * What can be trusted is counted from the right. If exactly one proxy sits in
 * front of this app, the last entry is the one that proxy added, and it is the
 * real peer address. With two hops it is the second from the right, and so on.
 * So the hop count is configuration, not a guess: `TRUSTED_PROXY_HOPS`.
 *
 * Getting the hop count wrong fails safe in one direction and not the other.
 * Too many hops walks left into caller-supplied text — bypassable. Too few
 * lands on a proxy address shared by many callers — over-strict, everyone
 * behind it shares one bucket. When the header is missing or unusable we fall
 * back to a single shared bucket, which throttles everyone together rather
 * than letting everyone through.
 */

/** Accepts IPv4, IPv6, and IPv6 written with a port or in brackets. */
function normaliseAddress(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  // "[2001:db8::1]:443" -> "2001:db8::1"
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1]!;
  // "192.0.2.1:443" -> "192.0.2.1" (only when it is unambiguously v4 + port)
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) value = value.split(':')[0]!;

  // Anything with a character that cannot appear in an address is either a
  // header injection attempt or junk; either way it must not become a key.
  if (!/^[0-9a-fA-F.:]+$/.test(value)) return null;
  if (value.length > 45) return null;

  return value.toLowerCase();
}

/**
 * The caller's address, or null when it genuinely cannot be determined.
 *
 * Trusts only the hop the deployment says is in front of it.
 */
export function clientIp(request: Request): string | null {
  const hops = Math.max(1, env().TRUSTED_PROXY_HOPS);

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const chain = forwarded
      .split(',')
      .map(normaliseAddress)
      .filter((value): value is string => value !== null);

    if (chain.length > 0) {
      // Count from the right: the rightmost entry was written by the proxy
      // closest to us, which is the one we actually trust.
      const index = Math.max(0, chain.length - hops);
      const address = chain[index];
      if (address) return address;
    }
  }

  // Platforms that state the peer directly are better than any chain, but not
  // every host sets them.
  for (const header of ['x-real-ip', 'cf-connecting-ip', 'fly-client-ip']) {
    const value = request.headers.get(header);
    const address = value ? normaliseAddress(value) : null;
    if (address) return address;
  }

  return null;
}

/**
 * A rate-limit key for this caller.
 *
 * `scope` keeps unrelated limits from sharing a bucket, so a visitor spending
 * their upload allowance does not also lock themselves out of signing in.
 *
 * An unidentifiable caller falls back to one shared bucket rather than being
 * waved through: throttling a few legitimate people together is recoverable,
 * and an unlimited hole is not.
 */
export function rateLimitKey(request: Request, scope: string): string {
  return `${scope}:${clientIp(request) ?? 'unknown-peer'}`;
}
