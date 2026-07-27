import { LedgerReason } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '@/server/db';
import { fail, handleError, ok } from '@/server/api/respond';
import { createSession, hashPassword, setSessionCookie } from '@/server/auth/session';

const SIGNUP_CREDITS = 50;

const schema = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  name: z.string().trim().max(120).optional(),
});

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const email = body.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return fail('An account with that email already exists. Try signing in instead.', 409);
    }

    const user = await prisma.user.create({
      data: {
        email,
        name: body.name || null,
        passwordHash: await hashPassword(body.password),
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

    const { token, expiresAt } = await createSession(user.id);
    await setSessionCookie(token, expiresAt);

    return ok({ user }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
