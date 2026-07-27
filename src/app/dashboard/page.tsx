import type { Metadata } from 'next';
import Link from 'next/link';
import { BatchStatus, ImageSourceKind, ProductStatus } from '@prisma/client';

import { BatchStatusBadge } from '@/components/status';
import { Card, CardHeader, EmptyState, formatDate, LinkButton, ProgressBar } from '@/components/ui';
import { currentUser } from '@/server/auth/session';
import { prisma } from '@/server/db';
import { generationStatus } from '@/server/providers/generate';
import { providerStatus } from '@/server/providers/search';

export const metadata: Metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await currentUser();
  if (!user) return null;

  const [batches, totals, imageKinds, recentBatches] = await Promise.all([
    prisma.batch.count({ where: { userId: user.id } }),
    prisma.product.groupBy({
      by: ['status'],
      where: { batch: { userId: user.id } },
      _count: { _all: true },
    }),
    prisma.imageAsset.groupBy({
      by: ['kind'],
      where: { product: { batch: { userId: user.id } } },
      _count: { _all: true },
    }),
    prisma.batch.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: {
        id: true,
        name: true,
        status: true,
        totalProducts: true,
        successCount: true,
        failedCount: true,
        processedCount: true,
        createdAt: true,
      },
    }),
  ]);

  const byStatus = Object.fromEntries(totals.map((t) => [t.status, t._count._all])) as Record<
    ProductStatus,
    number | undefined
  >;
  const kinds = Object.fromEntries(imageKinds.map((k) => [k.kind, k._count._all])) as Record<
    ImageSourceKind,
    number | undefined
  >;

  const totalProducts = totals.reduce((sum, t) => sum + t._count._all, 0);
  const succeeded = byStatus.SUCCEEDED ?? 0;
  const failed = byStatus.FAILED ?? 0;
  const inFlight = (byStatus.PENDING ?? 0) + (byStatus.PROCESSING ?? 0);

  const search = providerStatus();
  const configuredSearch = search.filter((p) => p.configured);
  const generation = generationStatus();

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-950">
            {user.name ? `Welcome back, ${user.name.split(' ')[0]}` : 'Overview'}
          </h1>
          <p className="mt-1 text-sm text-ink-500">
            {batches === 0
              ? 'Upload a supplier list to get your first catalog.'
              : `${batches} batch${batches === 1 ? '' : 'es'} processed so far.`}
          </p>
        </div>
        <LinkButton href="/dashboard/upload">New upload</LinkButton>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Images produced" value={succeeded.toLocaleString()} hint={`of ${totalProducts.toLocaleString()} products`} />
        <Stat
          label="Real photos"
          value={((kinds.REAL ?? 0) + (kinds.USER_PROVIDED ?? 0)).toLocaleString()}
          hint={`${(kinds.AI_GENERATED ?? 0).toLocaleString()} AI generated`}
        />
        <Stat label="In progress" value={inFlight.toLocaleString()} hint={inFlight > 0 ? 'processing now' : 'queue is clear'} />
        <Stat
          label="Credits left"
          value={user.credits.toLocaleString()}
          hint={failed > 0 ? `${failed} product${failed === 1 ? '' : 's'} need attention` : 'on the free plan'}
          tone={user.credits === 0 ? 'danger' : 'neutral'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader
            title="Recent batches"
            action={
              batches > 0 ? (
                <Link href="/dashboard/batches" className="text-sm font-medium text-accent-600 hover:text-accent-700">
                  View all
                </Link>
              ) : null
            }
          />
          {recentBatches.length === 0 ? (
            <EmptyState
              title="No uploads yet"
              description="Drop in a CSV or Excel product list and we will start finding images for every row."
              action={<LinkButton href="/dashboard/upload">Upload a product list</LinkButton>}
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {recentBatches.map((batch) => {
                const percent =
                  batch.totalProducts === 0
                    ? 0
                    : Math.round((batch.processedCount / batch.totalProducts) * 100);
                const running =
                  batch.status === BatchStatus.PROCESSING || batch.status === BatchStatus.QUEUED;

                return (
                  <li key={batch.id}>
                    <Link
                      href={`/dashboard/batches/${batch.id}`}
                      className="block px-5 py-4 transition hover:bg-ink-50"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink-900">{batch.name}</p>
                          <p className="mt-0.5 text-xs text-ink-500">
                            {batch.totalProducts.toLocaleString()} products · {formatDate(batch.createdAt)}
                          </p>
                        </div>
                        <BatchStatusBadge status={batch.status} />
                      </div>
                      {running ? (
                        <div className="mt-3">
                          <ProgressBar percent={percent} />
                          <p className="mt-1.5 text-xs text-ink-500">
                            {batch.processedCount.toLocaleString()} of{' '}
                            {batch.totalProducts.toLocaleString()} processed
                          </p>
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-ink-500">
                          {batch.successCount.toLocaleString()} images
                          {batch.failedCount > 0
                            ? ` · ${batch.failedCount.toLocaleString()} failed`
                            : ''}
                        </p>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Pipeline configuration" description="What this instance can do right now." />
          <dl className="divide-y divide-ink-100 text-sm">
            <ConfigRow
              label="Image sources"
              value={
                configuredSearch.length === 0
                  ? 'None configured'
                  : `${configuredSearch.length} active`
              }
              detail={configuredSearch.map((p) => p.name).join(', ') || 'Add API keys to enable search'}
              ok={configuredSearch.length > 0}
            />
            <ConfigRow
              label="AI generation"
              value={generation.enabled ? (generation.provider ?? 'enabled') : 'Off'}
              detail={
                generation.enabled
                  ? 'Products with no real photo get a generated one'
                  : (generation.reason ?? 'Fallback generation is disabled')
              }
              ok={generation.enabled}
            />
          </dl>
          <div className="border-t border-ink-100 px-5 py-4">
            <p className="text-xs leading-relaxed text-ink-500">
              Providers are configured with environment variables. See{' '}
              <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-[11px]">.env.example</code>{' '}
              for the full list.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <Card className="px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{label}</p>
      <p
        className={
          tone === 'danger'
            ? 'mt-1.5 text-2xl font-semibold tracking-tight text-danger-600'
            : 'mt-1.5 text-2xl font-semibold tracking-tight text-ink-950'
        }
      >
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-xs text-ink-500">{hint}</p> : null}
    </Card>
  );
}

function ConfigRow({
  label,
  value,
  detail,
  ok,
}: {
  label: string;
  value: string;
  detail: string;
  ok: boolean;
}) {
  return (
    <div className="px-5 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <dt className="text-sm font-medium text-ink-800">{label}</dt>
        <dd className="flex items-center gap-1.5 text-sm text-ink-600">
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-positive-600' : 'bg-ink-400'}`}
          />
          {value}
        </dd>
      </div>
      <p className="mt-1 text-xs text-ink-500">{detail}</p>
    </div>
  );
}
