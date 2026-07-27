import 'dotenv/config';

import { env } from '@/lib/env';
import { buildExport } from '@/server/export/build-export';
import { runProductJob } from '@/server/pipeline/run-product-job';
import {
  connectionOptions,
  EXPORT_QUEUE,
  PRODUCT_QUEUE,
  type ExportJobData,
  type ProductJobData,
} from '@/server/queue';

/**
 * Worker entry point. Run one or many of these alongside the web app:
 *
 *   QUEUE_DRIVER=redis npm run worker
 *
 * Concurrency is per-process, so throughput scales by raising
 * WORKER_CONCURRENCY or by starting more processes.
 */
async function main() {
  const config = env();

  if (config.QUEUE_DRIVER !== 'redis') {
    console.error(
      'QUEUE_DRIVER is "inline", so jobs run inside the web process and this worker has nothing to do.\n' +
        'Set QUEUE_DRIVER=redis (and REDIS_URL) to run a dedicated worker.',
    );
    process.exit(1);
  }

  const { Worker } = await import('bullmq');
  const connection = connectionOptions();

  const productWorker = new Worker<ProductJobData>(
    PRODUCT_QUEUE,
    async (job) => {
      const result = await runProductJob(job.data.productId);
      if (result.status === 'failed') {
        // The failure is already recorded on the product row. Throwing lets
        // BullMQ apply its backoff so transient upstream errors get retried.
        throw new Error(result.message ?? 'Product processing failed');
      }
      return result;
    },
    {
      connection,
      concurrency: config.WORKER_CONCURRENCY,
      // Image downloads and model calls are slow; a generous lock avoids
      // BullMQ stealing a job that is still legitimately running.
      lockDuration: 5 * 60 * 1000,
    },
  );

  const exportWorker = new Worker<ExportJobData>(
    EXPORT_QUEUE,
    async (job) => {
      await buildExport(job.data.exportId);
    },
    { connection, concurrency: 2, lockDuration: 15 * 60 * 1000 },
  );

  productWorker.on('failed', (job, error) => {
    console.error(`[worker] product ${job?.data.productId} failed:`, error.message);
  });
  exportWorker.on('failed', (job, error) => {
    console.error(`[worker] export ${job?.data.exportId} failed:`, error.message);
  });
  productWorker.on('completed', (job) => {
    console.log(`[worker] product ${job.data.productId} done`);
  });

  console.log(
    `[worker] listening on "${PRODUCT_QUEUE}" and "${EXPORT_QUEUE}" ` +
      `(concurrency ${config.WORKER_CONCURRENCY})`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, finishing in-flight jobs…`);
    await Promise.allSettled([productWorker.close(), exportWorker.close()]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  console.error('[worker] fatal', error);
  process.exit(1);
});
