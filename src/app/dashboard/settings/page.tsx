import type { Metadata } from 'next';

import { Badge, Card, CardHeader, formatDate } from '@/components/ui';
import { env } from '@/lib/env';
import { currentUser } from '@/server/auth/session';
import { prisma } from '@/server/db';
import { backgroundRemovalMode } from '@/server/providers/bgremove';
import { generationStatus } from '@/server/providers/generate';
import { understandingProvider } from '@/server/providers/llm/enrichment';
import { providerStatus } from '@/server/providers/search';
import { queue } from '@/server/queue';
import { ApiKeys } from './api-keys';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) return null;

  const config = env();
  const [ledger, usedThisMonth] = await Promise.all([
    prisma.creditLedger.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 12,
    }),
    prisma.creditLedger.aggregate({
      where: {
        userId: user.id,
        delta: { lt: 0 },
        createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
      },
      _sum: { delta: true },
    }),
  ]);

  const search = providerStatus();
  const generation = generationStatus();
  const understanding = understandingProvider();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Settings</h1>
        <p className="mt-1 text-sm text-ink-500">Your account, usage, and pipeline configuration.</p>
      </div>

      <Card>
        <CardHeader title="Account" />
        <dl className="divide-y divide-ink-100 text-sm">
          <Row label="Email" value={user.email} />
          <Row label="Name" value={user.name ?? '—'} />
          <Row label="Plan" value={user.plan} />
          <Row label="Member since" value={formatDate(user.createdAt)} />
        </dl>
      </Card>

      <Card>
        <CardHeader
          title="Usage"
          description="One credit per product processed. Failed products are not charged."
        />
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <Stat label="Credits remaining" value={user.credits.toLocaleString()} />
          <Stat label="Used this month" value={Math.abs(usedThisMonth._sum.delta ?? 0).toLocaleString()} />
          <Stat label="Plan" value={user.plan} />
        </div>

        {ledger.length > 0 ? (
          <div className="border-t border-ink-100">
            <ul className="divide-y divide-ink-100">
              {ledger.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                  <div>
                    <p className="text-ink-800">{describeReason(entry.reason)}</p>
                    <p className="text-xs text-ink-500">
                      {formatDate(entry.createdAt)}
                      {entry.note ? ` · ${entry.note}` : ''}
                    </p>
                  </div>
                  <span
                    className={
                      entry.delta > 0
                        ? 'font-medium tabular-nums text-positive-600'
                        : 'font-medium tabular-nums text-ink-600'
                    }
                  >
                    {entry.delta > 0 ? '+' : ''}
                    {entry.delta}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>

      <Card>
        <CardHeader title="API access" />
        <ApiKeys />
      </Card>

      <Card>
        <CardHeader
          title="Pipeline configuration"
          description="Read from the server environment. Restart the app after changing these."
        />
        <div className="space-y-5 p-5">
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Image sources — Workflow A
            </h3>
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {search.map((provider) => (
                <li
                  key={provider.name}
                  className="flex items-center justify-between rounded-lg border border-ink-200 px-3 py-2"
                >
                  <span className="text-sm text-ink-800">
                    {provider.name}
                    <span className="ml-1.5 text-xs text-ink-500">({provider.kind})</span>
                  </span>
                  <Badge tone={provider.configured ? 'positive' : 'neutral'}>
                    {provider.configured ? (provider.keyless ? 'Active (free)' : 'Active') : 'No key'}
                  </Badge>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Fallback generation — Workflow B
            </h3>
            <div className="mt-2 flex items-center justify-between rounded-lg border border-ink-200 px-3 py-2">
              <span className="text-sm text-ink-800">
                {generation.provider ?? 'Disabled'}
                {generation.reason ? (
                  <span className="ml-1.5 text-xs text-ink-500">{generation.reason}</span>
                ) : null}
              </span>
              <Badge tone={generation.enabled ? 'positive' : 'neutral'}>
                {generation.enabled ? 'Active' : 'Off'}
              </Badge>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Infrastructure</h3>
            <dl className="mt-2 divide-y divide-ink-100 rounded-lg border border-ink-200 text-sm">
              <Row label="Queue" value={queue().name} compact />
              <Row label="Storage" value={config.STORAGE_DRIVER} compact />
              <Row
                label="Product understanding"
                value={
                  understanding.model
                    ? `${understanding.provider} · ${understanding.model}`
                    : 'heuristic (no API key)'
                }
                compact
              />
              <Row label="Background removal" value={backgroundRemovalMode()} compact />
              <Row
                label="Max products per batch"
                value={config.MAX_PRODUCTS_PER_BATCH.toLocaleString()}
                compact
              />
            </dl>
          </section>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value, compact }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={compact ? 'flex justify-between gap-3 px-3 py-2' : 'flex justify-between gap-3 px-5 py-3'}>
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right font-medium text-ink-900">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-ink-200 px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight text-ink-950">{value}</p>
    </div>
  );
}

function describeReason(reason: string): string {
  switch (reason) {
    case 'SIGNUP_GRANT':
      return 'Free trial credits';
    case 'PLAN_RENEWAL':
      return 'Plan renewal';
    case 'MANUAL_ADJUSTMENT':
      return 'Manual adjustment';
    case 'IMAGE_SOURCED':
      return 'Product image sourced';
    case 'IMAGE_GENERATED':
      return 'Product image generated';
    case 'REFUND_FAILED':
      return 'Refund for failed product';
    default:
      return reason;
  }
}
