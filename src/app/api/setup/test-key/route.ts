import { limit } from '@/server/api/guard';
import { handleError, ok } from '@/server/api/respond';
import { cachedKeyTest } from '@/server/setup/diagnostics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Ask OpenAI, right now, whether the configured key works.
 *
 * This is the only check that can tell a revoked key from an unfunded account,
 * and those two need completely different fixes. It costs at most one token.
 */
export async function POST(request: Request) {
  try {
    // Each check is a real API call against the configured key. Meant to be
    // pressed by an operator, not polled.
    const refused = limit(request, 'setupCheck');
    if (refused) return refused;

    return ok(await cachedKeyTest());
  } catch (error) {
    return handleError(error);
  }
}
