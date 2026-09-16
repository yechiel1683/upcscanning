import { LedgerReason } from '@prisma/client';
import { z } from 'zod';

import { limit, sameOrigin } from '@/server/api/guard';
import { fail, handleError, ok } from '@/server/api/respond';
import { createSession, setSessionCookie } from '@/server/auth/session';
import { VerificationPurpose, checkCode } from '@/server/auth/verification';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGNUP_CREDITS = 50;

const schema = z.object({
  email: z.string().email(),
  // Spaces and dashes are what people paste; strip them rather than refuse.
  code: z.string().min(4).max(16),
});

/**
 * Step two: the code is right, so the account exists.
 *
 * The free credits are granted here rather than at step one, which is the
 * point of splitting the flow — an address nobody can read never receives an
 * allowance, so a script cannot mint credits from invented addresses.
 */
export async function POST(request: Request) {
  try {
    const forged = sameOrigin(request);
    if (forged) return forged;

    // Guessing a code is an attack on the account, so it is rate limited like
    // a login rather than like a signup.
    const refused = limit(request, 'login');
    if (refused) return refused;

    const body = schema.parse(await request.json());
    const address = body.email.toLowerCase().trim();

    const result = await checkCode(address, VerificationPurpose.SIGNUP, body.code);

    if (!result.ok) {
      const message =
        result.reason === 'too-many-attempts'
          ? 'Too many incorrect codes. Request a new one to try again.'
          : result.reason === 'expired'
            ? 'That code has expired. Request a new one.'
            : 'That code is not right. Check the email and try again.';
      return fail(message, 400, { reason: result.reason });
    }

    if (!result.pendingPasswordHash) {
      // The code was valid but carried no signup details, which means it was
      // issued for something else. Refusing is the only safe answer.
      return fail('That code cannot be used to create an account.', 400);
    }

    // Between sending the code and entering it, the same address may have been
    // registered another way. Creating would violate the unique index; saying
    // so plainly is better than a 500.
    const existing = await prisma.user.findUnique({
      where: { email: address },
      select: { id: true },
    });
    if (existing) {
      return fail('An account with that email already exists. Try signing in instead.', 409);
    }

    const user = await prisma.user.create({
      data: {
        email: address,
        name: result.pendingName,
        passwordHash: result.pendingPasswordHash,
        emailVerified: new Date(),
        credits: SIGNUP_CREDITS,
        ledger: {
          create: {
            delta: SIGNUP_CREDITS,
            reason: LedgerReason.SIGNUP_GRANT,
            note: 'Free trial credits',
          },
        },
      },
      select: { id: true, email: true, name: true, plan: true, credits: true },
    });

    // Signed in immediately: they have just proven the address and typed the
    // password, so asking them to type it again is friction with no purpose.
    const { token, expiresAt } = await createSession(user.id);
    await setSessionCookie(token, expiresAt);

    return ok({ user }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
