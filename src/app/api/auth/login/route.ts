import { limit, sameOrigin } from '@/server/api/guard';
import { z } from 'zod';

import { prisma } from '@/server/db';
import { fail, handleError, ok } from '@/server/api/respond';
import {
  createSession,
  currentSessionToken,
  destroySession,
  setSessionCookie,
  verifyPassword,
} from '@/server/auth/session';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const forged = sameOrigin(request);
    if (forged) return forged;

    // Tight enough to make credential stuffing useless, loose enough to
    // survive somebody genuinely mistyping their password.
    const refused = limit(request, 'login');
    if (refused) return refused;

    const body = schema.parse(await request.json());
    const email = body.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({ where: { email } });

    // Always run a comparison so a missing account and a wrong password take
    // the same amount of time.
    const valid = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyPassword(body.password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');

    if (!user || !valid) return fail('That email and password combination is not correct.', 401);

    // Retire whatever session this browser arrived holding before issuing the
    // new one. The cookie is replaced either way, so this is about the row
    // behind it: a token someone else already has stays valid until it expires
    // unless logging in revokes it.
    const presented = await currentSessionToken();
    if (presented) await destroySession(presented);

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
