import { ENV_KEYS, env } from '@/lib/env';

/**
 * Setup diagnostics.
 *
 * The capabilities endpoint answers "is this instance configured?" — useful
 * before spending money, useless when the answer is no and you have just spent
 * ten minutes setting the variable it asked for. This module answers the next
 * question: *why* is it still no.
 *
 * There are only a few ways a key fails to arrive, and they are indistinguishable
 * from inside the process unless you go looking for them specifically:
 *
 *   - it was never set, or was set on a different service;
 *   - it was set under a slightly wrong name (`OPENAI_KEY`, a trailing space);
 *   - it arrived wrapped in the quotes someone copied along with it;
 *   - it arrived intact but the account behind it has no credit.
 *
 * Each one produces the same symptom. Naming which one it is turns an
 * afternoon of guessing into one sentence.
 *
 * Nothing here ever reports a value — only names, lengths, and shapes.
 */

export type CheckStatus = 'ok' | 'problem' | 'note';

export interface SetupCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
}

export interface MisnamedVariable {
  /** The name that is actually set in the environment. */
  present: string;
  /** The name this application reads. */
  expected: string;
}

/* ------------------------------------------------------------------ names */

function normalise(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function tokens(name: string): string[] {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** Levenshtein distance, bounded by the inputs we feed it (short names). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Find variables that were probably meant to be one of ours.
 *
 * Deliberately conservative. A false positive here sends someone to rename a
 * variable that was fine, so a candidate must look like the distinctive part of
 * a known name (`OPENAI`, `DATABASE`) *and* like its trailing part (`KEY`,
 * `URL`). `AWS_SECRET_ACCESS_KEY` is not reported as a near-miss for
 * `S3_SECRET_ACCESS_KEY`, because `S3` is too short to carry that judgement.
 */
export function detectMisnamedVariables(
  source: Record<string, string | undefined>,
  known: readonly string[] = ENV_KEYS,
): MisnamedVariable[] {
  const knownSet = new Set(known);
  const byNormalised = new Map(known.map((name) => [normalise(name), name]));
  const found: MisnamedVariable[] = [];

  for (const [name, value] of Object.entries(source)) {
    if (knownSet.has(name)) continue;
    // An empty variable is not evidence of intent.
    if (value === undefined || value.trim() === '') continue;

    // `openai-api-key`, `OPENAIAPIKEY`, or a name with a stray trailing space.
    const exact = byNormalised.get(normalise(name));
    if (exact) {
      found.push({ present: name, expected: exact });
      continue;
    }

    const candidateTokens = tokens(name);
    let best: { expected: string; score: number } | null = null;

    for (const target of known) {
      const targetTokens = tokens(target);
      const head = targetTokens[0];
      const tail = targetTokens[targetTokens.length - 1];
      // Short leading tokens (S3, GO) cannot distinguish anything.
      if (!head || !tail || head.length < 4) continue;

      const headScore = Math.min(...candidateTokens.map((t) => editDistance(t, head)));
      const tailScore = Math.min(...candidateTokens.map((t) => editDistance(t, tail)));
      if (headScore > 2 || tailScore > 1) continue;

      // Every word must belong. Without this, DATABASE_PUBLIC_URL — which
      // Railway sets on every project with a Postgres service attached — reads
      // as a misspelling of DATABASE_URL, and the check cries wolf on a
      // perfectly ordinary deployment. A typo drops or mangles a word; it does
      // not introduce a new, correctly spelled one.
      const everyWordBelongs = candidateTokens.every((token) =>
        targetTokens.some((target) => editDistance(token, target) <= 1),
      );
      if (!everyWordBelongs) continue;

      const score = headScore + tailScore;
      if (!best || score < best.score) best = { expected: target, score };
    }

    if (best) found.push({ present: name, expected: best.expected });
  }

  return found;
}

/* ------------------------------------------------------------------ shape */

/**
 * Problems visible in the raw string itself.
 *
 * These matter because a malformed key is *worse* than a missing one: the
 * provider reports itself configured, every request goes out, and every request
 * comes back 401. Reading the raw value rather than the parsed one is the whole
 * point — the schema deliberately does not clean these up, because silently
 * repairing a secret hides the mistake instead of fixing it.
 */
export function inspectSecretShape(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  const issues: string[] = [];

  if (/^["'].*["']$/.test(raw)) {
    issues.push(
      'The value is wrapped in quotes. Railway stores the value literally, so the ' +
        'quotes are being sent as part of the key. Remove them.',
    );
  }
  if (raw !== raw.trim()) {
    issues.push('The value has a space or line break at the start or end. Remove it.');
  }
  if (/\s/.test(raw.trim())) {
    issues.push(
      'The value contains a space or line break in the middle, so it was probably ' +
        'truncated or wrapped when it was copied. Paste it again in one piece.',
    );
  }
  if (/^(your|paste|xxx|<|\.\.\.)/i.test(raw.trim())) {
    issues.push('The value still looks like placeholder text rather than a real key.');
  } else if (!raw.trim().replace(/^["']|["']$/g, '').startsWith('sk-')) {
    issues.push(
      'OpenAI keys start with "sk-". This value does not, so it may be an ' +
        'organisation ID or a project ID rather than the key itself.',
    );
  }

  return issues;
}

/* ------------------------------------------------------------------ checks */

export interface SetupReport {
  checks: SetupCheck[];
  misnamed: MisnamedVariable[];
  /** True when the OpenAI key is present and free of shape problems. */
  keyLooksValid: boolean;
}

export function buildSetupReport(
  source: Record<string, string | undefined> = process.env,
): SetupReport {
  const checks: SetupCheck[] = [];
  const misnamed = detectMisnamedVariables(source);
  const raw = source.OPENAI_API_KEY;
  const shape = inspectSecretShape(raw);
  const present = raw !== undefined && raw.trim() !== '';

  if (!present) {
    const hint = misnamed.find((v) => v.expected === 'OPENAI_API_KEY');
    checks.push({
      id: 'openai-key',
      status: 'problem',
      title: 'OPENAI_API_KEY is not reaching this server',
      detail: hint
        ? `This server has a variable named "${hint.present}", but the application reads ` +
          `OPENAI_API_KEY. Rename it and redeploy.`
        : 'No variable by that name is set on the running process. If you added it in ' +
          'Railway, check that you added it to this service (not the Postgres service), ' +
          'that any staged change was deployed, and that the deployment that followed ' +
          'finished successfully.',
    });
  } else if (shape.length > 0) {
    checks.push({
      id: 'openai-key',
      status: 'problem',
      title: 'OPENAI_API_KEY is set but malformed',
      detail: shape.join(' '),
    });
  } else {
    checks.push({
      id: 'openai-key',
      status: 'ok',
      title: 'OPENAI_API_KEY is set',
      detail: `The server has a key of ${raw!.trim().length} characters. Run the live check ` +
        'below to confirm the account behind it works.',
    });
  }

  for (const variable of misnamed) {
    if (variable.expected === 'OPENAI_API_KEY' && !present) continue;
    checks.push({
      id: `misnamed-${variable.present}`,
      status: 'note',
      title: `"${variable.present}" is set but never read`,
      detail: `This application reads ${variable.expected}. If that was the intention, ` +
        'rename the variable and redeploy.',
    });
  }

  return { checks, misnamed, keyLooksValid: present && shape.length === 0 };
}

/* --------------------------------------------------------------- live test */

export type KeyTestState =
  | 'ok'
  | 'missing'
  | 'invalid'
  | 'no_credit'
  | 'rate_limited'
  | 'model_unavailable'
  | 'unreachable'
  | 'error';

export interface KeyTestResult {
  state: KeyTestState;
  message: string;
  /** HTTP status from OpenAI, when there was one. */
  status?: number;
}

const MESSAGES: Record<KeyTestState, string> = {
  ok: 'The key works and the account can make requests. This instance is ready to process products.',
  missing: 'There is no key set on this server, so there was nothing to test.',
  invalid:
    'OpenAI rejected this key. It has been revoked, or it was copied incompletely. ' +
    'Create a new one and replace the value.',
  no_credit:
    'The key is valid, but the OpenAI account behind it has no available credit. API ' +
    'billing is separate from a ChatGPT subscription — add a payment method and a ' +
    'balance at platform.openai.com under Billing.',
  rate_limited:
    'OpenAI is rate-limiting this key right now. The key itself is fine; wait a moment ' +
    'and try again.',
  model_unavailable:
    'The key works, but this project cannot use the configured model. Check the model ' +
    'permissions for the project the key belongs to.',
  unreachable:
    'This server could not reach api.openai.com at all. That is a network or egress ' +
    'problem on the host, not a problem with the key.',
  error: 'OpenAI returned an unexpected response.',
};

function result(state: KeyTestState, status?: number, extra?: string): KeyTestResult {
  return {
    state,
    status,
    message: extra ? `${MESSAGES[state]} ${extra}` : MESSAGES[state],
  };
}

/**
 * Classify an OpenAI HTTP response.
 *
 * Split out from the request so the mapping — the part that is easy to get
 * subtly wrong, and the part that decides what the user is told to go and fix —
 * can be tested without a network.
 */
export function classifyOpenAiResponse(status: number, body: unknown): KeyTestResult {
  const code =
    typeof body === 'object' && body !== null
      ? ((body as { error?: { code?: string; message?: string } }).error?.code ?? null)
      : null;
  const message =
    typeof body === 'object' && body !== null
      ? ((body as { error?: { message?: string } }).error?.message ?? null)
      : null;

  if (status === 200) return result('ok');
  if (status === 401) return result('invalid', status);
  if (status === 403) return result('invalid', status);
  if (status === 429) {
    return code === 'insufficient_quota'
      ? result('no_credit', status)
      : result('rate_limited', status);
  }
  if (status === 404 && (code === 'model_not_found' || /model/i.test(message ?? ''))) {
    return result('model_unavailable', status);
  }
  return result('error', status, message ? `OpenAI said: ${message}` : undefined);
}

/**
 * Ask OpenAI whether the key actually works.
 *
 * Two calls, because they answer different questions and the first cannot answer
 * the second: listing models proves the key authenticates, but an account with
 * no credit lists models happily and refuses to complete anything. The
 * completion is capped at one token, so the test costs a fraction of a cent.
 */
export async function testOpenAiKey(fetchImpl: typeof fetch = fetch): Promise<KeyTestResult> {
  const config = env();
  const key = config.OPENAI_API_KEY?.trim();
  if (!key) return result('missing');

  const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  try {
    const auth = await fetchImpl('https://api.openai.com/v1/models', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!auth.ok) return classifyOpenAiResponse(auth.status, await readJson(auth));

    const probe = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.OPENAI_TEXT_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    return classifyOpenAiResponse(probe.status, await readJson(probe));
  } catch (error) {
    if (error instanceof Error && /abort|timeout/i.test(error.name + error.message)) {
      return result('unreachable', undefined, 'The request timed out.');
    }
    return result('unreachable');
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- throttled wrapper */

/**
 * The live test is reachable without an account, because the instance it
 * diagnoses may have no database to hold accounts in — that is frequently the
 * very state it is being used to explain.
 *
 * Two things keep that from being a way to spend this server's money: the answer
 * is cached for a minute, and concurrent callers share the one call in flight
 * rather than each starting their own. Between them, traffic of any size costs
 * at most one upstream request a minute — which is also why there is no
 * additional rate floor here. A floor shorter than the cache window can never be
 * reached, and a safeguard that cannot fire is worse than none: it reads like
 * protection while doing nothing.
 */
const CACHE_MS = 60_000;

let cached: { at: number; result: KeyTestResult } | null = null;
let inFlight: Promise<KeyTestResult> | null = null;

export type CachedKeyTest = KeyTestResult & { cached: boolean };

export async function cachedKeyTest(now = Date.now()): Promise<CachedKeyTest> {
  if (cached && now - cached.at < CACHE_MS) return { ...cached.result, cached: true };
  if (inFlight) return { ...(await inFlight), cached: true };

  inFlight = testOpenAiKey();
  try {
    const result = await inFlight;
    cached = { at: Date.now(), result };
    return { ...result, cached: false };
  } finally {
    inFlight = null;
  }
}

/** Test hook: forget the cached answer. */
export function resetKeyTestCache(): void {
  cached = null;
  inFlight = null;
}
