import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import type { User } from '@prisma/client';

import { env } from '@/lib/env';
import { prisma } from '@/server/db';

/**
 * Session handling.
 *
 * Opaque random tokens in an httpOnly cookie, with only a SHA-256 hash stored
 * server-side. A JWT would avoid the database read, but opaque tokens can be
 * revoked immediately, which matters more for an account that can spend money.
 */

export const SESSION_COOKIE = 'cf_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });

  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env().NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function destroySession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export type SessionUser = Pick<User, 'id' | 'email' | 'name' | 'plan' | 'credits' | 'createdAt'>;

/** Resolve the signed-in user, or null. Never throws. */
export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userFromToken(token);
}

export async function userFromToken(token: string): Promise<SessionUser | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        select: { id: true, email: true, name: true, plan: true, credits: true, createdAt: true },
      },
    },
  });

  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  return session.user;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

const API_KEY_PREFIX = 'cf_live_';

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const secret = randomBytes(24).toString('base64url');
  const key = `${API_KEY_PREFIX}${secret}`;
  return { key, prefix: key.slice(0, 12), hash: hashToken(key) };
}

/**
 * Resolve a bearer API key. Used by the programmatic API so integrations do not
 * need a browser session.
 */
export async function userFromApiKey(key: string): Promise<SessionUser | null> {
  if (!key.startsWith(API_KEY_PREFIX)) return null;

  const record = await prisma.apiKey.findUnique({
    where: { keyHash: hashToken(key) },
    include: {
      user: {
        select: { id: true, email: true, name: true, plan: true, credits: true, createdAt: true },
      },
    },
  });

  if (!record || record.revokedAt) return null;

  // Constant-time comparison on the hash, belt and braces alongside the unique
  // index lookup above.
  const provided = Buffer.from(hashToken(key));
  const stored = Buffer.from(record.keyHash);
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) return null;

  // Fire-and-forget: last-used tracking must not slow the request down.
  void prisma.apiKey
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return record.user;
}

/** Resolve a user from either a session cookie or an Authorization header. */
export async function authenticate(request: Request): Promise<SessionUser | null> {
  const header = request.headers.get('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) {
    const user = await userFromApiKey(header.slice(7).trim());
    if (user) return user;
  }
  return currentUser();
}
