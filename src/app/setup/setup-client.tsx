'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, CardHeader, cn } from '@/components/ui';

/**
 * The setup page.
 *
 * Its job is to end a specific and demoralising loop: the app says a variable is
 * missing, you set that variable, and the app still says it is missing. From the
 * outside those two states are identical. This page separates them — it says
 * whether the value arrived, whether it looks like a key, and whether the
 * account behind it can actually be charged.
 */

type CheckStatus = 'ok' | 'problem' | 'note';

interface SetupCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
}

interface Diagnostics {
  build?: { commit: string; startedAt: string };
  checks: SetupCheck[];
  keyLooksValid: boolean;
  capabilities: {
    barcodeLookup: { count: number; providers: string[] };
    webSearch: { enabled: boolean; providers: string[] };
    generation: { enabled: boolean; provider: string | null };
    identification: string;
    fullyConfigured: boolean;
  };
}

interface KeyTest {
  state: string;
  message: string;
  status?: number;
}

const STATUS_TONE: Record<CheckStatus, string> = {
  ok: 'border-positive/40 bg-positive-soft',
  problem: 'border-warning/40 bg-warning-soft',
  note: 'border-line bg-surface-2',
};

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: 'OK',
  problem: 'Action needed',
  note: 'Note',
};

const GOOD_STATES = new Set(['ok']);

export function SetupClient() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [test, setTest] = useState<KeyTest | null>(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch('/api/setup/diagnostics', { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      setData((await response.json()) as Diagnostics);
    } catch {
      setLoadError('Could not read this instance’s configuration.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runTest() {
    setTesting(true);
    try {
      const response = await fetch('/api/setup/test-key', { method: 'POST' });
      const body = (await response.json()) as KeyTest & { error?: string };
      setTest(response.ok ? body : { state: 'error', message: body.error ?? 'The check failed.' });
    } catch {
      setTest({ state: 'error', message: 'The check did not reach the server.' });
    } finally {
      setTesting(false);
    }
  }

  if (loadError) {
    return (
      <Card className="border-warning/40 bg-warning-soft">
        <p className="p-4 text-sm text-fg">{loadError}</p>
      </Card>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted">Reading configuration…</p>;
  }

  const { capabilities: caps } = data;

  return (
    <div className="space-y-6">
      <Card className={caps.fullyConfigured ? 'border-positive/40 bg-positive-soft' : undefined}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-semibold text-fg">
              {caps.fullyConfigured
                ? 'This instance is fully configured'
                : 'This instance is only partly set up'}
            </p>
            <p className="mt-0.5 text-sm text-muted">
              {caps.fullyConfigured
                ? 'Web image search and generated images are both available.'
                : 'Products that the free barcode databases do not carry will fail.'}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            Re-check
          </Button>
        </div>
        {data.build ? (
          <p className="border-t border-line-soft px-4 py-2.5 font-mono text-xs text-subtle">
            build {data.build.commit} · running since{' '}
            {new Date(data.build.startedAt).toLocaleString()}
          </p>
        ) : null}
      </Card>

      <div className="space-y-3">
        {data.checks.map((check) => (
          <Card key={check.id} className={STATUS_TONE[check.status]}>
            <div className="p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold text-fg">{check.title}</p>
                <Badge tone={check.status === 'ok' ? 'positive' : check.status === 'problem' ? 'warning' : 'neutral'}>
                  {STATUS_LABEL[check.status]}
                </Badge>
              </div>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{check.detail}</p>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader
          title="Live key check"
          description="Asks OpenAI whether the configured key authenticates and whether the account can be charged. Costs one token."
          action={
            <Button size="sm" onClick={() => void runTest()} disabled={testing}>
              {testing ? 'Checking…' : 'Run check'}
            </Button>
          }
        />
        {test ? (
          <div
            className={cn(
              'mx-5 mb-5 mt-4 rounded-xl border p-4 text-sm leading-relaxed',
              GOOD_STATES.has(test.state)
                ? 'border-positive/40 bg-positive-soft text-fg'
                : 'border-warning/40 bg-warning-soft text-fg',
            )}
          >
            {test.message}
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="What this instance can do right now" />
        <dl className="divide-y divide-line border-t border-line text-sm">
          <Row
            label="Barcode databases"
            value={
              caps.barcodeLookup.count > 0
                ? `${caps.barcodeLookup.count} available — ${caps.barcodeLookup.providers.join(', ')}`
                : 'None'
            }
            good={caps.barcodeLookup.count > 0}
          />
          <Row
            label="Web image search"
            value={caps.webSearch.enabled ? caps.webSearch.providers.join(', ') : 'Off'}
            good={caps.webSearch.enabled}
          />
          <Row
            label="Generated images"
            value={caps.generation.enabled ? (caps.generation.provider ?? 'On') : 'Off'}
            good={caps.generation.enabled}
          />
          <Row
            label="Product identification"
            value={caps.identification === 'heuristic' ? 'Built-in rules' : caps.identification}
            good={caps.identification !== 'heuristic'}
          />
        </dl>
      </Card>

      <Card>
        <CardHeader title="Setting the key on Railway" />
        <ol className="space-y-2 px-5 py-4 text-sm leading-relaxed text-muted">
          <li>1. Open your project and click the service running this app — not the Postgres service.</li>
          <li>
            2. Go to <span className="font-medium text-fg">Variables</span> →{' '}
            <span className="font-medium text-fg">New Variable</span>.
          </li>
          <li>
            3. Name it exactly{' '}
            <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">
              OPENAI_API_KEY
            </code>
            . Paste the value with no quotes and no trailing space.
          </li>
          <li>
            4. If Railway shows the change as staged, click{' '}
            <span className="font-medium text-fg">Deploy</span> — a staged variable is not live yet.
          </li>
          <li>5. Wait for the new deployment to go green, then press Re-check above.</li>
        </ol>
      </Card>
    </div>
  );
}

function Row({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3">
      <dt className="text-muted">{label}</dt>
      <dd className={cn('text-right font-medium', good ? 'text-fg' : 'text-warning')}>{value}</dd>
    </div>
  );
}
