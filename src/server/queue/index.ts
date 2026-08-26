import { env } from '@/lib/env';

/**
 * Job queue.
 *
 * Two drivers behind one interface:
 *
 *  - redis  — BullMQ. What you run in production: durable, retried, spread
 *             across as many worker processes as you care to start.
 *  - inline — a bounded in-process pool. No infrastructure, so `npm run dev`
 *             works on a laptop with nothing but Postgres. Jobs are lost if the
 *             process restarts, which is why it is not the production default.
 */

export const PRODUCT_QUEUE = 'product-processing';
export const EXPORT_QUEUE = 'export-building';

/** Exported for the tests that pin the deduplication rule. */
export function productJobId(data: { productId: string; attempt?: number }): string {
  return data.attempt ? `product:${data.productId}:${data.attempt}` : `product:${data.productId}`;
}

export interface ProductJobData {
  productId: string;
  batchId: string;
  /**
   * Which pass this is, used only to keep the job distinguishable from the one
   * that scheduled it. Deduplication is keyed on the product, so a retry queued
   * from inside a still-running job — or one queued while the previous job is
   * still in the completed window — collides with it and is dropped, leaving
   * the row pending forever. Passing the attempt count gives each pass its own
   * key while still collapsing genuine duplicates within a pass.
   */
  attempt?: number;
}

export interface ExportJobData {
  exportId: string;
  batchId: string;
}

export interface QueueDriver {
  readonly name: 'redis' | 'inline';
  enqueueProducts(jobs: ProductJobData[]): Promise<void>;
  enqueueExport(job: ExportJobData): Promise<void>;
  /** Best-effort depth reading for the dashboard. */
  stats(): Promise<{ waiting: number; active: number }>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Inline driver
// ---------------------------------------------------------------------------

class InlineQueue implements QueueDriver {
  readonly name = 'inline' as const;

  private readonly pending: Array<() => Promise<void>> = [];
  private active = 0;

  constructor(private readonly concurrency: number) {}

  async enqueueProducts(jobs: ProductJobData[]): Promise<void> {
    for (const job of jobs) {
      this.pending.push(async () => {
        const { runProductJob } = await import('@/server/pipeline/run-product-job');
        await runProductJob(job.productId);
      });
    }
    this.drain();
  }

  async enqueueExport(job: ExportJobData): Promise<void> {
    this.pending.push(async () => {
      const { buildExport } = await import('@/server/export/build-export');
      await buildExport(job.exportId);
    });
    this.drain();
  }

  async stats() {
    return { waiting: this.pending.length, active: this.active };
  }

  async close(): Promise<void> {
    this.pending.length = 0;
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) break;
      this.active += 1;
      void task()
        .catch((error) => {
          // A job that throws here has already recorded its own failure state;
          // log so the cause is not swallowed entirely.
          console.error('[inline-queue] job failed', error);
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}

// ---------------------------------------------------------------------------
// Redis driver
// ---------------------------------------------------------------------------

class RedisQueue implements QueueDriver {
  readonly name = 'redis' as const;

  private products: import('bullmq').Queue<ProductJobData> | null = null;
  private exports: import('bullmq').Queue<ExportJobData> | null = null;

  private async productQueue() {
    if (!this.products) {
      const { Queue } = await import('bullmq');
      this.products = new Queue<ProductJobData>(PRODUCT_QUEUE, {
        connection: connectionOptions(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 1000, age: 24 * 3600 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      });
    }
    return this.products;
  }

  private async exportQueue() {
    if (!this.exports) {
      const { Queue } = await import('bullmq');
      this.exports = new Queue<ExportJobData>(EXPORT_QUEUE, {
        connection: connectionOptions(),
        defaultJobOptions: {
          attempts: 2,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: { count: 200, age: 24 * 3600 },
        },
      });
    }
    return this.exports;
  }

  async enqueueProducts(jobs: ProductJobData[]): Promise<void> {
    if (jobs.length === 0) return;
    const queue = await this.productQueue();
    // addBulk in chunks so a 5,000-product batch does not build one enormous
    // pipeline command.
    const CHUNK = 500;
    for (let i = 0; i < jobs.length; i += CHUNK) {
      await queue.addBulk(
        jobs.slice(i, i + CHUNK).map((data) => ({
          name: 'process-product',
          data,
          // Deduplicate within a pass: enqueueing the same product twice for
          // the same attempt is a no-op while that job is still around.
          opts: { jobId: productJobId(data) },
        })),
      );
    }
  }

  async enqueueExport(job: ExportJobData): Promise<void> {
    const queue = await this.exportQueue();
    await queue.add('build-export', job, { jobId: `export:${job.exportId}` });
  }

  async stats() {
    try {
      const queue = await this.productQueue();
      const [waiting, active] = await Promise.all([queue.getWaitingCount(), queue.getActiveCount()]);
      return { waiting, active };
    } catch {
      return { waiting: 0, active: 0 };
    }
  }

  async close(): Promise<void> {
    await this.products?.close();
    await this.exports?.close();
    this.products = null;
    this.exports = null;
  }
}

export function connectionOptions() {
  const url = new URL(env().REDIS_URL);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    // BullMQ requires this for blocking commands.
    maxRetriesPerRequest: null as null,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

let driver: QueueDriver | null = null;

export function queue(): QueueDriver {
  if (driver) return driver;
  const config = env();
  driver =
    config.QUEUE_DRIVER === 'redis'
      ? new RedisQueue()
      : new InlineQueue(Math.max(1, Math.min(config.WORKER_CONCURRENCY, 16)));
  return driver;
}

/** Test hook. */
export function setQueueDriver(next: QueueDriver | null): void {
  driver = next;
}
