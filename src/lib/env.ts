import { z } from 'zod';

/**
 * Environment parsing.
 *
 * Almost everything is optional on purpose: the platform has to boot and be
 * useful with zero third-party keys configured. Each provider decides for
 * itself whether it has what it needs (see `providers/*`), and the pipeline
 * routes around the ones that don't.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive());

const str = z.string().optional().transform((v) => (v === '' ? undefined : v));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().default('postgresql://localhost:5432/upcscanning'),
  // No signing secret is needed: a session is an opaque 32-byte random token,
  // stored server-side as a SHA-256 hash and revocable by deleting the row.
  APP_URL: z.string().default('http://localhost:3000'),

  QUEUE_DRIVER: z.enum(['inline', 'redis']).default('inline'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  WORKER_CONCURRENCY: int(8),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: str,
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: str,
  S3_ACCESS_KEY_ID: str,
  S3_SECRET_ACCESS_KEY: str,
  S3_FORCE_PATH_STYLE: bool(false),

  UPCITEMDB_API_KEY: str,
  GOUPC_API_KEY: str,
  GOOGLE_CSE_API_KEY: str,
  GOOGLE_CSE_ENGINE_ID: str,
  BING_SEARCH_API_KEY: str,
  SERPAPI_KEY: str,

  // "auto" turns generation on for whichever provider has a key, so a single
  // OPENAI_API_KEY is enough to get the fallback path working.
  IMAGE_GENERATION_PROVIDER: z
    .enum(['auto', 'none', 'openai', 'replicate', 'stability'])
    .default('auto'),
  OPENAI_API_KEY: str,
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-1'),
  OPENAI_TEXT_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_SEARCH_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_WEB_SEARCH: z.enum(['on', 'off']).default('on'),
  REPLICATE_API_TOKEN: str,
  REPLICATE_MODEL: z.string().default('black-forest-labs/flux-1.1-pro'),
  STABILITY_API_KEY: str,
  STABILITY_MODEL: z.string().default('sd3.5-large'),

  ANTHROPIC_API_KEY: str,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),

  BACKGROUND_REMOVAL_PROVIDER: z.enum(['auto', 'removebg', 'none']).default('auto'),
  REMOVEBG_API_KEY: str,

  // Barcode lookups are cached and shared across batches and users, because a
  // GTIN resolves to the same product forever.
  LOOKUP_CACHE_ENABLED: bool(true),
  LOOKUP_CACHE_TTL_DAYS: int(90),
  LOOKUP_CACHE_MISS_TTL_DAYS: int(7),

  MAX_UPLOAD_BYTES: int(50 * 1024 * 1024),
  MAX_PRODUCTS_PER_BATCH: int(5000),
  MAX_IMAGE_DOWNLOAD_BYTES: int(15 * 1024 * 1024),
  HTTP_TIMEOUT_MS: int(20_000),
});

export type Env = z.infer<typeof schema>;

/**
 * Every variable name this application reads.
 *
 * Exported so the setup diagnostics can spot a variable that was *meant* to be
 * one of these and isn't — `OPENAI_KEY`, `DATABSE_URL`. A typo in the name is
 * invisible from inside the process (the value simply isn't there), which makes
 * it the single hardest configuration mistake to find by looking.
 */
export const ENV_KEYS: readonly string[] = Object.freeze(Object.keys(schema.shape));

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: forget the memoised environment after mutating process.env. */
export function resetEnvCache(): void {
  cached = null;
}
