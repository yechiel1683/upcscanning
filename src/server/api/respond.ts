import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

import { authenticate, type SessionUser } from '@/server/auth/session';
import { asDatabaseProblem } from './errors';

/** Consistent JSON envelopes so the dashboard can handle every error the same way. */

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return NextResponse.json({ error: message, ...extra }, { status });
}

export function unauthorized(): NextResponse {
  return fail('You need to sign in to do that.', 401);
}

export function notFound(what = 'Resource'): NextResponse {
  return fail(`${what} not found.`, 404);
}

/** Turn a thrown error into a response without leaking internals to the client. */
export function handleError(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    return fail(
      first ? `${first.path.join('.') || 'request'}: ${first.message}` : 'Invalid request.',
      422,
      { issues: error.issues },
    );
  }

  // A misconfigured database is not a mystery to be retried — say what it is.
  const database = asDatabaseProblem(error);
  if (database) {
    console.error(`[api] database ${database.fault}:`, error);
    return fail(database.message, 503, { fault: database.fault });
  }

  console.error('[api] unhandled error', error);
  return fail('Something went wrong on our end. Please try again.', 500);
}

/** Wrap a handler so it always has an authenticated user. */
export function withUser<T extends unknown[]>(
  handler: (user: SessionUser, request: Request, ...args: T) => Promise<Response>,
) {
  return async (request: Request, ...args: T): Promise<Response> => {
    try {
      const user = await authenticate(request);
      if (!user) return unauthorized();
      return await handler(user, request, ...args);
    } catch (error) {
      return handleError(error);
    }
  };
}
