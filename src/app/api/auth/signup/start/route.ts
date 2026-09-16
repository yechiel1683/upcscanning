import { z } from 'zod';

import { limit, sameOrigin } from '@/server/api/guard';
import { fail, handleError, ok } from '@/server/api/respond';
import { hashPassword } from '@/server/auth/session';
import { VERIFICATION_LIMITS, VerificationPurpose, issueCode } from '@/server/auth/verification';
import { email as mailer } from '@/server/email';
import { signupCodeEmail } from '@/server/email/templates';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  name: z.string().trim().max(120).optional(),
});

/**
 * Step one of signing up: send a code, create nothing.
 *
 * No User row exists until the address is proven. The password is hashed now
 * and carried on the verification code, so an abandoned signup leaves a row
 * that expires and is swept rather than a permanent unverified account
 * occupying the email address somebody else may legitimately own.
 *
 * The reply is deliberately identical whether or not that address already has
 * an account. Saying "this email is taken" turns the signup form into a way to
 * ask whether any given person is a customer — which for a business tool means
 * telling a competitor who your customers are.
 */
export async function POST(request: Request) {
  try {
    const forged = sameOrigin(request);
    if (forged) return forged;

    const refused = limit(request, 'register');
    if (refused) return refused;

    const body = schema.parse(await request.json());
    const address = body.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({
      where: { email: address },
      select: { id: true },
    });

    // Same answer either way, and the same work either way — an existing
    // address that returned instantly while a new one paused to hash a
    // password would leak the difference through timing.
    const passwordHash = await hashPassword(body.password);

    if (!existing) {
      const issued = await issueCode({
        email: address,
        purpose: VerificationPurpose.SIGNUP,
        pendingName: body.name || null,
        pendingPasswordHash: passwordHash,
      });

      if (issued) {
        const result = await mailer().send(
          signupCodeEmail(address, issued.code, Math.round(VERIFICATION_LIMITS.TTL_MS / 60_000)),
        );
        // A failed send is worth reporting: the customer is about to stare at
        // a code-entry screen waiting for something that never left.
        if (!result.sent) {
          console.error('[auth] could not send signup code', result.error);
          return fail(
            'We could not send the confirmation email just now. Please try again in a moment.',
            502,
          );
        }
      }
    }

    return ok({
      sent: true,
      expiresInMinutes: Math.round(VERIFICATION_LIMITS.TTL_MS / 60_000),
    });
  } catch (error) {
    return handleError(error);
  }
}
