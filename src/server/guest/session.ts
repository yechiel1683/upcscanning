import { cookies } from 'next/headers';

import { env } from '@/lib/env';
import { createGuestSession, getGuestSession, GUEST_TTL_MS, type GuestSession } from './store';

export const GUEST_COOKIE = 'cf_guest';

/** Resolve the current guest session, or null. */
export async function currentGuest(): Promise<GuestSession | null> {
  const store = await cookies();
  return getGuestSession(store.get(GUEST_COOKIE)?.value);
}

/** Start a guest session and set its cookie. */
export async function startGuest(): Promise<GuestSession> {
  const session = createGuestSession();
  const store = await cookies();
  store.set(GUEST_COOKIE, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().NODE_ENV === 'production',
    path: '/',
    expires: new Date(Date.now() + GUEST_TTL_MS),
  });
  return session;
}

export async function endGuest(): Promise<void> {
  const store = await cookies();
  store.delete(GUEST_COOKIE);
}
