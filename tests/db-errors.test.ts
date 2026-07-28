import { describe, expect, it } from 'vitest';

import { asDatabaseProblem } from '@/server/api/errors';

/**
 * These encode the failure that made the deployed app say "try again" to
 * someone whose only problem was an unconnected database.
 */

class PrismaError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
  }
}

describe('asDatabaseProblem', () => {
  it('recognises an unreachable server by code', () => {
    const problem = asDatabaseProblem(new PrismaError('Cannot connect', 'P1001'));
    expect(problem?.fault).toBe('unreachable');
    expect(problem?.message).toMatch(/DATABASE_URL/);
  });

  it('recognises an unreachable server by message', () => {
    const problem = asDatabaseProblem(
      new Error("Can't reach database server at `postgres.railway.internal:5432`"),
    );
    expect(problem?.fault).toBe('unreachable');
  });

  it('recognises a client that could not initialise at all', () => {
    const error = new Error('Environment variable not found: DATABASE_URL');
    error.name = 'PrismaClientInitializationError';
    expect(asDatabaseProblem(error)?.fault).toBe('unreachable');
  });

  it('recognises DNS failures, which is how private networking fails', () => {
    expect(asDatabaseProblem(new Error('getaddrinfo ENOTFOUND db.internal'))?.fault).toBe(
      'unreachable',
    );
  });

  it('distinguishes a connected database with no tables', () => {
    const problem = asDatabaseProblem(
      new PrismaError('The table `public.users` does not exist in the current database.', 'P2021'),
    );
    expect(problem?.fault).toBe('schema-missing');
    expect(problem?.message).toMatch(/migrate deploy|Redeploy/);
  });

  it('leaves ordinary application errors alone', () => {
    // These must stay generic: the user cannot act on them and the text leaks.
    expect(asDatabaseProblem(new Error('Cannot read properties of undefined'))).toBeNull();
    expect(asDatabaseProblem(new PrismaError('Unique constraint failed', 'P2002'))).toBeNull();
    expect(asDatabaseProblem(null)).toBeNull();
  });
});
