import { afterEach, describe, expect, it } from 'vitest';

import { resetEnvCache } from '@/lib/env';
import { inspectConfiguration, reportConfiguration, type Check } from '@/server/preflight';

/**
 * These encode what "deployed but broken" looks like. A container that builds
 * and boots can still be misconfigured in ways that only surface as a 500
 * during a request, or — worse — as images that quietly vanish on the next
 * redeploy. Preflight has to name those at boot.
 */

const saved = { ...process.env };

function configure(vars: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
  return inspectConfiguration();
}

function find(checks: Check[], fragment: string): Check | undefined {
  return checks.find((check) => check.title.toLowerCase().includes(fragment.toLowerCase()));
}

const healthyProduction = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pw@db.internal:5432/catalogforge',
  STORAGE_DRIVER: 's3',
  S3_BUCKET: 'catalog',
  QUEUE_DRIVER: 'redis',
  OPENAI_API_KEY: 'sk-test',
};

afterEach(() => {
  Object.assign(process.env, saved);
  resetEnvCache();
});

describe('inspectConfiguration', () => {
  it('is quiet when production is set up properly', () => {
    expect(configure(healthyProduction)).toEqual([]);
  });

  it('refuses a production database still pointing at localhost', () => {
    const checks = configure({ ...healthyProduction, DATABASE_URL: 'postgresql://localhost:5432/x' });
    const check = find(checks, 'localhost');

    expect(check?.severity).toBe('fatal');
    // In a container, localhost is the container — the most common first-deploy
    // mistake, and one that only shows up as a 500 later.
    expect(check?.detail).toMatch(/container/i);
  });

  it('warns that local storage will lose the customer catalog', () => {
    const checks = configure({ ...healthyProduction, STORAGE_DRIVER: 'local', S3_BUCKET: undefined });
    const check = find(checks, 'container filesystem');

    expect(check?.severity).toBe('warn');
    expect(check?.detail).toMatch(/redeploy/i);
    expect(check?.detail).toMatch(/volume|S3/i);
  });

  it('warns that inline processing does not survive a restart', () => {
    const checks = configure({ ...healthyProduction, QUEUE_DRIVER: 'inline' });
    const check = find(checks, 'web process');

    expect(check?.severity).toBe('warn');
    expect(check?.detail).toMatch(/QUEUE_DRIVER=redis/);
  });

  it('warns when nothing can search the web for images', () => {
    const checks = configure({
      ...healthyProduction,
      OPENAI_API_KEY: undefined,
      SERPAPI_KEY: undefined,
      BING_SEARCH_API_KEY: undefined,
      GOOGLE_CSE_API_KEY: undefined,
    });

    const check = find(checks, 'image search');
    expect(check?.severity).toBe('warn');
    expect(check?.detail).toMatch(/OPENAI_API_KEY/);
  });

  it('accepts any one search provider as sufficient', () => {
    const withSerp = configure({
      ...healthyProduction,
      OPENAI_API_KEY: undefined,
      SERPAPI_KEY: 'serp-test',
    });
    expect(find(withSerp, 'image search')).toBeUndefined();
  });

  it('treats heuristic identification as information, not a problem', () => {
    const checks = configure({
      ...healthyProduction,
      OPENAI_API_KEY: undefined,
      SERPAPI_KEY: 'serp-test',
      ANTHROPIC_API_KEY: undefined,
    });

    expect(find(checks, 'built-in rules')?.severity).toBe('info');
  });

  it('does not nag about local storage or inline queues in development', () => {
    const checks = configure({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://localhost:5432/catalogforge',
      STORAGE_DRIVER: 'local',
      QUEUE_DRIVER: 'inline',
      OPENAI_API_KEY: 'sk-test',
    });

    // All three are the correct local defaults; warning about them would train
    // people to ignore the output.
    expect(checks).toEqual([]);
  });
});

describe('reportConfiguration', () => {
  it('allows boot when nothing is fatal', () => {
    expect(reportConfiguration([])).toBe(true);
    expect(
      reportConfiguration([{ severity: 'warn', title: 'w', detail: 'd' }]),
    ).toBe(true);
  });

  it('blocks boot on a fatal problem', () => {
    expect(
      reportConfiguration([{ severity: 'fatal', title: 'f', detail: 'd' }]),
    ).toBe(false);
  });
});
