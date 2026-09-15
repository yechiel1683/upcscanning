import { limit } from '@/server/api/guard';
import { handleError, ok } from '@/server/api/respond';
import { testWebSearch } from '@/server/setup/web-search-test';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Ask the web image search, right now, whether it actually works.
 *
 * Separate from the key test because they fail independently and for different
 * reasons: a key can be valid, funded, and completely unable to browse. When
 * that happens every product silently falls back to the barcode databases
 * alone, which looks like a catalog of unphotographed products rather than a
 * setting to change.
 */
export async function POST(request: Request) {
  try {
    // A real browsing call against the configured key, so it costs money.
    const refused = limit(request, 'setupCheck');
    if (refused) return refused;

    return ok(await testWebSearch());
  } catch (error) {
    return handleError(error);
  }
}
