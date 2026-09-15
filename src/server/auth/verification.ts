import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import { VerificationPurpose } from '@prisma/client';

import { prisma } from '@/server/db';

/**
 * One-time codes sent to an email address.
 *
 * Six digits, which on its own is a million possibilities and no obstacle at
 * all to a script. The code is not what makes this safe — three controls are,
 * and each closes a different door:
 *
 *   attempts   Five wrong answers kill the code. This is the one that matters:
 *              it turns a million guesses into five, whatever the code length.
 *   expiry     Ten minutes, so a code read from an old inbox months later is
 *              already dead. NIST puts a ten-minute ceiling on codes sent out
 *              of band, and there is no reason to be looser for email.
 *   single use The code is marked used the instant it is accepted, so the same
 *              one cannot be replayed even inside its window.
 *
 * Only a hash is stored, for the same reason session tokens are hashed: a
 * database dump must not hand somebody a working code for every pending
 * signup.
 *
 * Worth being clear about what this is: proof that somebody can read an inbox.
 * NIST does not accept email as an out-of-band authentication channel, because
 * an inbox is itself an account reachable from anywhere — often from the same
 * machine the password is saved on. So this verifies an address and recovers a
 * password. It is not a second factor, and should not be described as one.
 */

const CODE_LENGTH = 6;
const TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

/**
 * Codes that may be outstanding for one address and purpose at a time.
 *
 * Somebody who requests three codes because the first two were slow must be
 * able to use whichever one arrives, so old codes are not invalidated on
 * request. The ceiling stops that becoming a way to accumulate valid guesses.
 */
const MAX_OUTSTANDING = 3;

export { VerificationPurpose };

function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Digits only, and uniformly distributed.
 *
 * `randomInt` rather than `Math.random`, which is not a cryptographic source —
 * predicting the code would make every control above irrelevant.
 */
function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0');
}

/** Compare without leaking, through timing, how much of the code was right. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface IssuedCode {
  /** The plaintext, which exists only long enough to be emailed. */
  code: string;
  expiresAt: Date;
}

export interface IssueRequest {
  email: string;
  purpose: VerificationPurpose;
  /** Carried on a signup code so an unverified address never becomes a User. */
  pendingName?: string | null;
  pendingPasswordHash?: string | null;
}

/**
 * Issue a code, or refuse because too many are already outstanding.
 *
 * Returns null when the ceiling is reached. The caller must still tell the
 * customer the same thing it always does — see the note on enumeration in the
 * route — rather than reporting that this address has asked too often.
 */
export async function issueCode(request: IssueRequest): Promise<IssuedCode | null> {
  const email = request.email.toLowerCase().trim();
  const now = new Date();

  const outstanding = await prisma.verificationCode.count({
    where: {
      email,
      purpose: request.purpose,
      usedAt: null,
      expiresAt: { gt: now },
      attempts: { lt: MAX_ATTEMPTS },
    },
  });
  if (outstanding >= MAX_OUTSTANDING) return null;

  const code = generateCode();
  const expiresAt = new Date(now.getTime() + TTL_MS);

  await prisma.verificationCode.create({
    data: {
      email,
      purpose: request.purpose,
      codeHash: hash(code),
      expiresAt,
      pendingName: request.pendingName ?? null,
      pendingPasswordHash: request.pendingPasswordHash ?? null,
    },
  });

  return { code, expiresAt };
}

export type CheckResult =
  | { ok: true; pendingName: string | null; pendingPasswordHash: string | null }
  | { ok: false; reason: 'wrong' | 'expired' | 'too-many-attempts' };

/**
 * Check a code and, if it is right, spend it.
 *
 * Every outstanding code for this address and purpose is considered, because a
 * customer who requested three and typed the first one is not wrong. A wrong
 * answer costs an attempt on all of them, so guessing does not get cheaper by
 * requesting more codes.
 */
export async function checkCode(
  rawEmail: string,
  purpose: VerificationPurpose,
  submitted: string,
): Promise<CheckResult> {
  const email = rawEmail.toLowerCase().trim();
  const now = new Date();
  const digits = submitted.replace(/\D/g, '');

  const candidates = await prisma.verificationCode.findMany({
    where: { email, purpose, usedAt: null },
    orderBy: { createdAt: 'desc' },
    take: MAX_OUTSTANDING,
  });

  if (candidates.length === 0) return { ok: false, reason: 'expired' };

  const live = candidates.filter((row) => row.expiresAt > now);
  if (live.length === 0) return { ok: false, reason: 'expired' };

  const burned = live.filter((row) => row.attempts >= MAX_ATTEMPTS);
  if (burned.length === live.length) return { ok: false, reason: 'too-many-attempts' };

  const usable = live.filter((row) => row.attempts < MAX_ATTEMPTS);
  const submittedHash = hash(digits);
  const match = usable.find((row) => sameHash(row.codeHash, submittedHash));

  if (!match) {
    // Charged against every live code, so requesting more does not buy more
    // guesses. This is the control that makes six digits safe.
    await prisma.verificationCode.updateMany({
      where: { id: { in: usable.map((row) => row.id) } },
      data: { attempts: { increment: 1 } },
    });
    const wouldBurn = usable.every((row) => row.attempts + 1 >= MAX_ATTEMPTS);
    return { ok: false, reason: wouldBurn ? 'too-many-attempts' : 'wrong' };
  }

  // Spent atomically: the update only matches while usedAt is still null, so
  // two requests racing with the same correct code cannot both succeed.
  const spent = await prisma.verificationCode.updateMany({
    where: { id: match.id, usedAt: null },
    data: { usedAt: now },
  });
  if (spent.count === 0) return { ok: false, reason: 'expired' };

  // Anything else outstanding for this address is now moot.
  await prisma.verificationCode.updateMany({
    where: { email, purpose, usedAt: null },
    data: { usedAt: now },
  });

  return {
    ok: true,
    pendingName: match.pendingName,
    pendingPasswordHash: match.pendingPasswordHash,
  };
}

/**
 * Delete codes nobody can use any more.
 *
 * They carry a password hash for pending signups, so keeping spent ones is
 * keeping a credential for an account that may never exist.
 */
export async function sweepVerificationCodes(now = new Date()): Promise<number> {
  const { count } = await prisma.verificationCode.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: now } }, { usedAt: { not: null } }],
    },
  });
  return count;
}

export const VERIFICATION_LIMITS = { CODE_LENGTH, TTL_MS, MAX_ATTEMPTS, MAX_OUTSTANDING };
