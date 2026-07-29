import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetEnvCache } from '@/lib/env';
import {
  buildSetupReport,
  cachedKeyTest,
  classifyOpenAiResponse,
  detectMisnamedVariables,
  inspectSecretShape,
  resetKeyTestCache,
  testOpenAiKey,
} from '@/server/setup/diagnostics';

/**
 * These checks exist to tell somebody what to go and change. A wrong answer
 * here is worse than no answer: it sends them to fix something that was never
 * broken. So the cases that matter are the confusable ones — a key that is
 * present but malformed, a variable that merely looks like ours, and the
 * difference between a revoked key and an unfunded account.
 */

afterEach(() => {
  resetKeyTestCache();
  resetEnvCache();
  vi.restoreAllMocks();
});

describe('detectMisnamedVariables', () => {
  const known = ['OPENAI_API_KEY', 'DATABASE_URL', 'S3_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY'];

  it('catches a dropped word', () => {
    expect(detectMisnamedVariables({ OPENAI_KEY: 'sk-x' }, known)).toEqual([
      { present: 'OPENAI_KEY', expected: 'OPENAI_API_KEY' },
    ]);
  });

  it('catches a misspelling', () => {
    expect(detectMisnamedVariables({ DATABSE_URL: 'postgres://x' }, known)).toEqual([
      { present: 'DATABSE_URL', expected: 'DATABASE_URL' },
    ]);
  });

  it('catches wrong separators and casing', () => {
    const found = detectMisnamedVariables({ 'openai-api-key': 'sk-x' }, known);
    expect(found).toEqual([{ present: 'openai-api-key', expected: 'OPENAI_API_KEY' }]);
  });

  it('catches a trailing space in the name, which is invisible in a dashboard', () => {
    const found = detectMisnamedVariables({ 'OPENAI_API_KEY ': 'sk-x' }, known);
    expect(found).toEqual([{ present: 'OPENAI_API_KEY ', expected: 'OPENAI_API_KEY' }]);
  });

  it('says nothing about a correctly named variable', () => {
    expect(detectMisnamedVariables({ OPENAI_API_KEY: 'sk-x' }, known)).toEqual([]);
  });

  it('says nothing about unrelated variables', () => {
    const found = detectMisnamedVariables(
      { PATH: '/usr/bin', NODE_ENV: 'production', PORT: '3000', HOME: '/root' },
      known,
    );
    expect(found).toEqual([]);
  });

  it('does not mistake another vendor\'s credentials for ours', () => {
    // The single most likely false positive: same trailing words, different product.
    const found = detectMisnamedVariables(
      { AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', REDIS_URL: 'redis://x' },
      known,
    );
    expect(found).toEqual([]);
  });

  it('ignores an empty variable, which is not evidence of intent', () => {
    expect(detectMisnamedVariables({ OPENAI_KEY: '' }, known)).toEqual([]);
    expect(detectMisnamedVariables({ OPENAI_KEY: '   ' }, known)).toEqual([]);
  });

  it('keeps ANTHROPIC and OPENAI apart', () => {
    const found = detectMisnamedVariables({ ANTHROPIC_KEY: 'sk-ant-x' }, known);
    expect(found).toEqual([{ present: 'ANTHROPIC_KEY', expected: 'ANTHROPIC_API_KEY' }]);
  });

  it('does not flag a real variable that merely adds a word', () => {
    // Railway sets DATABASE_PUBLIC_URL on every project with Postgres attached.
    // Flagging it would mean crying wolf on an ordinary, correct deployment.
    expect(detectMisnamedVariables({ DATABASE_PUBLIC_URL: 'postgresql://x' }, known)).toEqual([]);
  });
});

describe('detectMisnamedVariables against a real Railway environment', () => {
  // The list this actually runs against in production, not a trimmed fixture.
  const RAILWAY = {
    PATH: '/usr/bin',
    HOME: '/root',
    NODE_ENV: 'production',
    PORT: '8080',
    RAILWAY_ENVIRONMENT: 'production',
    RAILWAY_PROJECT_NAME: 'upcscanning',
    RAILWAY_PUBLIC_DOMAIN: 'upcscanning.com',
    RAILWAY_PRIVATE_DOMAIN: 'web.railway.internal',
    RAILWAY_SERVICE_NAME: 'web',
    RAILWAY_STATIC_URL: 'x',
    RAILWAY_GIT_COMMIT_SHA: 'abc',
    DATABASE_PUBLIC_URL: 'postgresql://public',
    DATABASE_URL: 'postgresql://private',
    PGHOST: 'x',
    PGPORT: '5432',
    PGUSER: 'postgres',
    PGPASSWORD: 'x',
    PGDATABASE: 'railway',
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: 'x',
    POSTGRES_DB: 'railway',
    AWS_ACCESS_KEY_ID: 'x',
    AWS_SECRET_ACCESS_KEY: 'x',
    GITHUB_TOKEN: 'x',
    NIXPACKS_METADATA: 'node',
    NPM_CONFIG_PRODUCTION: 'false',
    REDIS_URL: 'redis://x',
    APP_URL: 'https://upcscanning.com',
  };

  it('stays silent on a correctly configured deployment', () => {
    expect(detectMisnamedVariables(RAILWAY)).toEqual([]);
  });

  it('finds the one typo among thirty correct variables', () => {
    expect(detectMisnamedVariables({ ...RAILWAY, OPENAI_KEY: 'sk-x' })).toEqual([
      { present: 'OPENAI_KEY', expected: 'OPENAI_API_KEY' },
    ]);
  });

  it('finds a name whose only fault is a trailing space', () => {
    expect(detectMisnamedVariables({ ...RAILWAY, 'OPENAI_API_KEY ': 'sk-x' })).toEqual([
      { present: 'OPENAI_API_KEY ', expected: 'OPENAI_API_KEY' },
    ]);
  });
});

describe('inspectSecretShape', () => {
  it('accepts a clean key', () => {
    expect(inspectSecretShape('sk-proj-abc123')).toEqual([]);
  });

  it('says nothing about an absent value — that is a different problem', () => {
    expect(inspectSecretShape(undefined)).toEqual([]);
    expect(inspectSecretShape('')).toEqual([]);
  });

  it('catches quotes copied along with the value', () => {
    expect(inspectSecretShape('"sk-proj-abc"').join(' ')).toMatch(/quotes/i);
  });

  it('catches surrounding whitespace', () => {
    expect(inspectSecretShape('sk-proj-abc\n').join(' ')).toMatch(/start or end/i);
  });

  it('catches a value broken across a line, which reads as valid but is truncated', () => {
    expect(inspectSecretShape('sk-proj-abc def').join(' ')).toMatch(/middle/i);
  });

  it('catches a value that is not an OpenAI key at all', () => {
    expect(inspectSecretShape('org-abc123').join(' ')).toMatch(/sk-/);
  });

  it('catches placeholder text', () => {
    expect(inspectSecretShape('your-key-here').join(' ')).toMatch(/placeholder/i);
  });

  it('does not also complain about the prefix when the value is a placeholder', () => {
    // Two messages contradicting each other is worse than one that is right.
    expect(inspectSecretShape('your-key-here')).toHaveLength(1);
  });
});

describe('buildSetupReport', () => {
  it('reports a missing key as the problem it is', () => {
    const report = buildSetupReport({});
    const check = report.checks.find((c) => c.id === 'openai-key');
    expect(check?.status).toBe('problem');
    expect(check?.title).toMatch(/not reaching/i);
    expect(report.keyLooksValid).toBe(false);
  });

  it('names the near-miss variable instead of repeating generic advice', () => {
    const report = buildSetupReport({ OPENAI_KEY: 'sk-abc' });
    const check = report.checks.find((c) => c.id === 'openai-key');
    expect(check?.detail).toContain('OPENAI_KEY');
    expect(check?.detail).toMatch(/rename/i);
  });

  it('does not report the same variable twice', () => {
    const report = buildSetupReport({ OPENAI_KEY: 'sk-abc' });
    expect(report.checks.filter((c) => c.detail.includes('OPENAI_KEY'))).toHaveLength(1);
  });

  it('distinguishes a malformed key from a missing one', () => {
    const report = buildSetupReport({ OPENAI_API_KEY: '"sk-abc"' });
    const check = report.checks.find((c) => c.id === 'openai-key');
    expect(check?.status).toBe('problem');
    expect(check?.title).toMatch(/malformed/i);
    expect(report.keyLooksValid).toBe(false);
  });

  it('accepts a clean key and reports its length, not its value', () => {
    const report = buildSetupReport({ OPENAI_API_KEY: 'sk-proj-abcdef' });
    const check = report.checks.find((c) => c.id === 'openai-key');
    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('14 characters');
    expect(report.keyLooksValid).toBe(true);
  });

  it('never puts the key itself in the report', () => {
    const secret = 'sk-proj-SUPERSECRETVALUE';
    const report = buildSetupReport({ OPENAI_API_KEY: secret, OPENAI_KEY: secret });
    expect(JSON.stringify(report)).not.toContain('SUPERSECRET');
  });
});

describe('classifyOpenAiResponse', () => {
  it('reads 200 as working', () => {
    expect(classifyOpenAiResponse(200, {}).state).toBe('ok');
  });

  it('reads 401 as a bad key', () => {
    expect(classifyOpenAiResponse(401, { error: { code: 'invalid_api_key' } }).state).toBe(
      'invalid',
    );
  });

  it('separates an unfunded account from ordinary rate limiting', () => {
    // Both are 429. Telling someone to "wait a moment" when the real fix is a
    // payment method costs them an afternoon.
    expect(classifyOpenAiResponse(429, { error: { code: 'insufficient_quota' } }).state).toBe(
      'no_credit',
    );
    expect(classifyOpenAiResponse(429, { error: { code: 'rate_limit_exceeded' } }).state).toBe(
      'rate_limited',
    );
  });

  it('points at billing, not at the key, when there is no credit', () => {
    const result = classifyOpenAiResponse(429, { error: { code: 'insufficient_quota' } });
    expect(result.message).toMatch(/billing/i);
    expect(result.message).toMatch(/separate from a ChatGPT subscription/i);
  });

  it('reads a missing model as a project permission problem', () => {
    expect(classifyOpenAiResponse(404, { error: { code: 'model_not_found' } }).state).toBe(
      'model_unavailable',
    );
  });

  it('passes an unexpected message through rather than inventing one', () => {
    const result = classifyOpenAiResponse(500, { error: { message: 'server is on fire' } });
    expect(result.state).toBe('error');
    expect(result.message).toContain('server is on fire');
  });
});

describe('testOpenAiKey', () => {
  function response(status: number, body: unknown): Response {
    return { ok: status === 200, status, json: async () => body } as Response;
  }

  it('does not call OpenAI when there is no key', async () => {
    process.env.OPENAI_API_KEY = '';
    resetEnvCache();
    const fetchImpl = vi.fn();

    expect((await testOpenAiKey(fetchImpl as unknown as typeof fetch)).state).toBe('missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('probes a completion even when the key authenticates, because credit is separate', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    resetEnvCache();
    const fetchImpl = vi
      .fn()
      // /v1/models succeeds for an unfunded account...
      .mockResolvedValueOnce(response(200, { data: [] }))
      // ...and only a real request reveals there is no credit.
      .mockResolvedValueOnce(response(429, { error: { code: 'insufficient_quota' } }));

    const result = await testOpenAiKey(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.state).toBe('no_credit');
  });

  it('caps the probe at one token so the check is effectively free', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    resetEnvCache();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(200, { data: [] }))
      .mockResolvedValueOnce(response(200, { choices: [] }));

    await testOpenAiKey(fetchImpl as unknown as typeof fetch);
    const body = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(body.max_tokens).toBe(1);
  });

  it('stops at the first call when the key is rejected', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    resetEnvCache();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(401, { error: {} }));

    expect((await testOpenAiKey(fetchImpl as unknown as typeof fetch)).state).toBe('invalid');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('calls an unreachable host a network problem, not a bad key', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    resetEnvCache();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    const result = await testOpenAiKey(fetchImpl as unknown as typeof fetch);
    expect(result.state).toBe('unreachable');
    expect(result.message).toMatch(/network/i);
  });

  it('never echoes the key it was given', async () => {
    process.env.OPENAI_API_KEY = 'sk-proj-SUPERSECRETVALUE';
    resetEnvCache();
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(401, { error: {} }));

    const result = await testOpenAiKey(fetchImpl as unknown as typeof fetch);
    expect(JSON.stringify(result)).not.toContain('SUPERSECRET');
  });
});

describe('cachedKeyTest', () => {
  it('serves a cached answer rather than calling OpenAI again', async () => {
    process.env.OPENAI_API_KEY = '';
    resetEnvCache();

    const first = await cachedKeyTest();
    const second = await cachedKeyTest();

    expect(first).toMatchObject({ state: 'missing', cached: false });
    expect(second).toMatchObject({ state: 'missing', cached: true });
  });

  it('re-checks once the cache has expired, so a fixed key is noticed', async () => {
    process.env.OPENAI_API_KEY = '';
    resetEnvCache();

    const now = Date.now();
    await cachedKeyTest(now);
    expect(await cachedKeyTest(now + 61_000)).toMatchObject({ cached: false });
  });

  it('collapses concurrent callers into a single upstream call', async () => {
    // This, with the cache, is the whole reason the route is safe to leave open.
    process.env.OPENAI_API_KEY = 'sk-test';
    resetEnvCache();

    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: false, status: 401, json: async () => ({ error: {} }) } as Response;
    });

    const results = await Promise.all([cachedKeyTest(), cachedKeyTest(), cachedKeyTest()]);

    expect(calls).toBe(1);
    expect(results.every((r) => r.state === 'invalid')).toBe(true);
  });
});
