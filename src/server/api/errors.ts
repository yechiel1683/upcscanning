/**
 * Turning database failures into something the person reading them can act on.
 *
 * "Something went wrong, please try again" is the worst possible answer to a
 * misconfigured deployment: it is untrue (trying again will never work) and it
 * hides the one fact that would fix it. For a self-hosted product the person
 * hitting the error is usually the person who can fix it, so connectivity and
 * schema problems say what is wrong and what to do.
 *
 * Only these two classes are surfaced. Genuine application bugs stay generic —
 * they leak internals and the user cannot act on them anyway.
 */

export type DatabaseFault = 'unreachable' | 'schema-missing';

export interface DatabaseProblem {
  fault: DatabaseFault;
  message: string;
}

/** Prisma codes meaning "the server is not there". */
const UNREACHABLE_CODES = new Set(['P1000', 'P1001', 'P1002', 'P1003', 'P1010', 'P1017']);

/** Prisma codes meaning "connected, but migrations have not run". */
const SCHEMA_CODES = new Set(['P2021', 'P2022']);

const UNREACHABLE_PATTERNS =
  /can't reach database server|connection refused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|Timed out fetching a new connection|server has closed the connection/i;

const SCHEMA_PATTERNS = /does not exist in the current database|relation ".*" does not exist/i;

function codeOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** Classify an error, or return null when it is not a database problem. */
export function asDatabaseProblem(error: unknown): DatabaseProblem | null {
  const code = codeOf(error);
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? '');

  const isInitError =
    error instanceof Error && error.name === 'PrismaClientInitializationError';

  if ((code && UNREACHABLE_CODES.has(code)) || isInitError || UNREACHABLE_PATTERNS.test(text)) {
    return {
      fault: 'unreachable',
      message:
        'The database is not reachable, so nothing can be saved yet. ' +
        'If this instance was just deployed, connect a PostgreSQL database and set DATABASE_URL, then redeploy.',
    };
  }

  if ((code && SCHEMA_CODES.has(code)) || SCHEMA_PATTERNS.test(text)) {
    return {
      fault: 'schema-missing',
      message:
        'The database is connected but its tables have not been created. ' +
        'Redeploy to run migrations, or run `npx prisma migrate deploy` against it.',
    };
  }

  return null;
}
