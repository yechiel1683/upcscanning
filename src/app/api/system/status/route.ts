import { env } from '@/lib/env';
import { handleError, ok } from '@/server/api/respond';
import { prisma } from '@/server/db';
import { backgroundRemovalMode } from '@/server/providers/bgremove';
import { generationStatus } from '@/server/providers/generate';
import { providerStatus } from '@/server/providers/search';
import { queue } from '@/server/queue';

/**
 * What the platform can currently do, given its configuration. The dashboard
 * surfaces this so a user understands *why* Workflow B is unavailable rather
 * than just seeing products fail.
 */
export async function GET() {
  try {
    const config = env();

    const database = await prisma
      .$queryRaw`SELECT 1`
      .then(() => true)
      .catch(() => false);

    const search = providerStatus();
    const generation = generationStatus();
    const stats = await queue().stats();

    return ok({
      database,
      queue: { driver: queue().name, ...stats },
      storage: config.STORAGE_DRIVER,
      productUnderstanding: {
        provider: config.ANTHROPIC_API_KEY ? 'anthropic' : 'heuristic',
        model: config.ANTHROPIC_API_KEY ? config.ANTHROPIC_MODEL : null,
      },
      imageSearch: {
        providers: search,
        configuredCount: search.filter((p) => p.configured).length,
      },
      imageGeneration: generation,
      backgroundRemoval: backgroundRemovalMode(),
      limits: {
        maxUploadBytes: config.MAX_UPLOAD_BYTES,
        maxProductsPerBatch: config.MAX_PRODUCTS_PER_BATCH,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
