import { cookies } from 'next/headers';

import { handleError, ok } from '@/server/api/respond';
import { clearSessionCookie, destroySession, SESSION_COOKIE } from '@/server/auth/session';

export async function POST() {
  try {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) await destroySession(token);
    await clearSessionCookie();
    return ok({ ok: true });
  } catch (error) {
    return handleError(error);
  }
}
