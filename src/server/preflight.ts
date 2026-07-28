import { env } from '@/lib/env';

/**
 * Startup checks.
 *
 * A container that builds and boots is not the same as a working service. The
 * things that actually break a deployment — no schema, an ephemeral disk
 * holding the customer's catalog, a database URL still pointing at localhost —
 * all fail *later*, during a request, as a stack trace nobody connects back to
 * configuration.
 *
 * So say it once, loudly, at boot.
 */

export type Severity = 'fatal' | 'warn' | 'info';

export interface Check {
  severity: Severity;
  title: string;
  detail: string;
}

/**
 * Config-only inspection: no I/O, so it is safe to run anywhere and easy to
 * test. Reachability is checked separately by the migrate step and /api/health.
 */
export function inspectConfiguration(): Check[] {
  const config = env();
  const checks: Check[] = [];
  const production = config.NODE_ENV === 'production';

  if (config.DATABASE_URL.includes('localhost') && production) {
    checks.push({
      severity: 'fatal',
      title: 'DATABASE_URL still points at localhost',
      detail:
        'In a container, localhost is the container itself. Point DATABASE_URL at your ' +
        'managed Postgres instance (on Railway, reference the Postgres service variable).',
    });
  }

  // The single most expensive misconfiguration: images are the product, and a
  // container filesystem does not survive a redeploy.
  if (config.STORAGE_DRIVER === 'local' && production) {
    checks.push({
      severity: 'warn',
      title: 'Images are being written to the container filesystem',
      detail:
        `STORAGE_DRIVER is "local", writing to ${config.STORAGE_LOCAL_DIR}. On most hosts ` +
        'that disk is wiped on every redeploy and not shared between replicas, so generated ' +
        'images and export ZIPs will disappear. Attach a persistent volume mounted at that ' +
        'path, or set STORAGE_DRIVER=s3.',
    });
  }

  if (config.QUEUE_DRIVER === 'inline' && production) {
    checks.push({
      severity: 'warn',
      title: 'Processing runs inside the web process',
      detail:
        'QUEUE_DRIVER is "inline", so jobs share the web server and are lost if it restarts ' +
        'mid-batch. Set QUEUE_DRIVER=redis with REDIS_URL and run `npm run worker` to make ' +
        'batches durable and scalable.',
    });
  }

  const hasImageSearch = Boolean(
    config.OPENAI_API_KEY ||
      config.SERPAPI_KEY ||
      config.BING_SEARCH_API_KEY ||
      (config.GOOGLE_CSE_API_KEY && config.GOOGLE_CSE_ENGINE_ID),
  );
  if (!hasImageSearch) {
    checks.push({
      severity: 'warn',
      title: 'No web image search is configured',
      detail:
        'Only the keyless barcode databases can find pictures, so products missing from them ' +
        'will fail. Set OPENAI_API_KEY to enable search, identification, and generation with ' +
        'one key.',
    });
  }

  if (!config.OPENAI_API_KEY && !config.ANTHROPIC_API_KEY) {
    checks.push({
      severity: 'info',
      title: 'Product identification is using built-in rules',
      detail:
        'Without OPENAI_API_KEY or ANTHROPIC_API_KEY, brand and model are extracted ' +
        'heuristically, which matches less accurately.',
    });
  }

  return checks;
}

const ICONS: Record<Severity, string> = { fatal: '✗', warn: '!', info: 'i' };

/** Print the checks. Returns true when nothing fatal was found. */
export function reportConfiguration(checks: Check[] = inspectConfiguration()): boolean {
  const fatal = checks.filter((check) => check.severity === 'fatal');

  if (checks.length === 0) {
    console.log('[preflight] configuration looks good');
    return true;
  }

  console.log('');
  for (const check of checks) {
    console.log(`[preflight] ${ICONS[check.severity]} ${check.title}`);
    for (const line of wrap(check.detail, 76)) console.log(`[preflight]   ${line}`);
  }
  console.log('');

  return fatal.length === 0;
}

function wrap(text: string, width: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
