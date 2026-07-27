import { z } from 'zod';

import { prisma } from '@/server/db';
import { fail, handleError, ok } from '@/server/api/respond';
import { createSession, setSessionCookie, verifyPassword } from '@/server/auth/session';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    const email = body.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({ where: { email } });

    // Always run a comparison so a missing account and a wrong password take
    // the same amount of time.
    const valid = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyPassword(body.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');

    if (!user || !valid) return fail('That email and password combination is not correct.', 401);

    const { token, expiresAt } = await createSession(user.id);
    await setSessionCookie(token, expiresAt);

    return ok({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        plan: user.plan,
        credits: user.credits,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
