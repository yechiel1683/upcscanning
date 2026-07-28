'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { BatchStatusBadge, ImageKindBadge, ProductStatusBadge } from '@/components/status';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  cn,
  EmptyState,
  formatBytes,
  formatDate,
  ProgressBar,
} from '@/components/ui';

/**
 * Batch detail.
 *
 * Polls while work is in flight and stops as soon as the batch settles — a
 * dashboard left open on a finished batch should not keep hitting the API.
 */

interface BatchResponse {
  batch: {
    id: string;
    name: string;
    status: string;
    originalFile: string;
    fileSizeBytes: number;
    renderOptions: Record<string, unknown> | null;
    createdAt: string;
    completedAt: string | null;
    errorMessage: string | null;
  };
  progress: {
    total: number;
    finished: number;
    percent: number;
    PENDING: number;
    PROCESSING: number;
    SUCCEEDED: number;
    FAILED: number;
    SKIPPED: number;
    isRunning: boolean;
  };
  imageKinds: Record<string, number>;
  exports: Array<{
    id: string;
    status: string;
    fileName: string;
    bytes: number | null;
    imageCount: number;
    errorMessage: string | null;
    createdAt: string;
    downloadUrl: string | null;
  }>;
}

interface ProductRow {
  id: string;
  rowNumber: number;
  sku: string | null;
  upc: string | null;
  name: string;
  brand: string | null;
  status: string;
  attempts: number;
  errorMessage: string | null;
  outputName: string | null;
  image: {
    id: string;
    kind: string;
    fileName: string;
    width: number;
    height: number;
    bytes: number;
    provider: string | null;
    sourceUrl: string | null;
    matchScore: number;
    qualityScore: number;
  } | null;
}

interface ProductsResponse {
  products: ProductRow[];
  page: number;
  totalPages: number;
  total: number;
}

const TABS = [
  { key: '', label: 'All' },
  { key: 'SUCCEEDED', label: 'Completed' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'PENDING', label: 'Pending' },
] as const;

const POLL_INTERVAL_MS = 3000;

export function BatchClient({ batchId }: { batchId: string }) {
  const [data, setData] = useState<BatchResponse | null>(null);
  const [products, setProducts] = useState<ProductsResponse | null>(null);
  const [tab, setTab] = useState<string>('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Held in a ref so the polling effect does not restart on every tick.
  const filters = useRef({ tab, page });
  filters.current = { tab, page };

  const loadBatch = useCallback(async () => {
    const response = await fetch(`/api/batches/${batchId}`, { cache: 'no-store' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'Could not load this batch.');
      return null;
    }
    const body = (await response.json()) as BatchResponse;
    setData(body);
    setError(null);
    return body;
  }, [batchId]);

  const loadProducts = useCallback(async () => {
    const params = new URLSearchParams({ page: String(filters.current.page), pageSize: '24' });
    if (filters.current.tab) params.set('status', filters.current.tab);

    const response = await fetch(`/api/batches/${batchId}/products?${params}`, {
      cache: 'no-store',
    });
    if (!response.ok) return;
    setProducts((await response.json()) as ProductsResponse);
  }, [batchId]);

  useEffect(() => {
    void loadBatch();
    void loadProducts();
  }, [loadBatch, loadProducts]);

  useEffect(() => {
    void loadProducts();
  }, [tab, page, loadProducts]);

  // Poll only while something is actually moving.
  useEffect(() => {
    if (!data?.progress.isRunning) return;

    const timer = setInterval(() => {
      void (async () => {
        const next = await loadBatch();
        await loadProducts();
        if (next && !next.progress.isRunning) clearInterval(timer);
      })();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [data?.progress.isRunning, loadBatch, loadProducts]);

  async function startExport() {
    setAction('export');
    setNotice(null);
    try {
      const response = await fetch(`/api/batches/${batchId}/export`, { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setNotice(body.error ?? 'Could not start the export.');
      } else {
        setNotice('Building your ZIP. It will appear below when it is ready.');
        await loadBatch();
        // The build is asynchronous; check back shortly for the download link.
        setTimeout(() => void loadBatch(), 4000);
      }
    } finally {
      setAction(null);
    }
  }

  async function retryFailed() {
    setAction('retry');
    setNotice(null);
    try {
      const response = await fetch(`/api/batches/${batchId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; retrying?: number };
      if (!response.ok) {
        setNotice(body.error ?? 'Could not retry those products.');
      } else {
        setNotice(`Retrying ${body.retrying ?? 0} product(s).`);
        await loadBatch();
        await loadProducts();
      }
    } finally {
      setAction(null);
    }
  }

  if (error) {
    return (
      <Card>
        <EmptyState
          title="We could not load this batch"
          description={error}
          action={
            <Link href="/dashboard/batches" className="text-sm font-medium text-accent">
              Back to batches
            </Link>
          }
        />
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="p-5">
        <div className="space-y-3">
          <div className="h-5 w-48 animate-pulse rounded bg-surface-2" />
          <div className="h-2 w-full animate-pulse rounded bg-surface-2" />
        </div>
      </Card>
    );
  }

  const { batch, progress } = data;
  const readyExport = data.exports.find((e) => e.status === 'READY');
  const buildingExport = data.exports.find((e) => e.status === 'PENDING' || e.status === 'BUILDING');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/dashboard/batches"
            className="text-sm text-muted transition hover:text-fg"
          >
            ← Batches
          </Link>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-fg">
              {batch.name}
            </h1>
            <BatchStatusBadge status={batch.status} />
          </div>
          <p className="mt-1 text-sm text-muted">
            {batch.originalFile} · {formatBytes(batch.fileSizeBytes)} · uploaded{' '}
            {formatDate(batch.createdAt)}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {progress.FAILED > 0 ? (
            <Button variant="secondary" onClick={() => void retryFailed()} disabled={action !== null}>
              {action === 'retry' ? 'Retrying…' : `Retry ${progress.FAILED} failed`}
            </Button>
          ) : null}
          {readyExport?.downloadUrl ? (
            <a href={readyExport.downloadUrl} className="inline-flex">
              <Button>Download ZIP ({formatBytes(readyExport.bytes)})</Button>
            </a>
          ) : (
            <Button
              onClick={() => void startExport()}
              disabled={action !== null || progress.SUCCEEDED === 0 || Boolean(buildingExport)}
            >
              {buildingExport
                ? 'Building ZIP…'
                : action === 'export'
                  ? 'Starting…'
                  : 'Build ZIP'}
            </Button>
          )}
        </div>
      </div>

      {notice ? (
        <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">{notice}</p>
      ) : null}

      {/* Progress */}
      <Card className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-fg">
            {progress.finished.toLocaleString()} of {progress.total.toLocaleString()} processed
          </p>
          <p className="text-sm text-muted">{progress.percent}%</p>
        </div>
        <div className="mt-2.5">
          <ProgressBar
            percent={progress.percent}
            tone={progress.FAILED > 0 && !progress.isRunning ? 'danger' : 'accent'}
          />
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Metric label="Images" value={progress.SUCCEEDED} tone="positive" />
          <Metric label="Failed" value={progress.FAILED} tone={progress.FAILED > 0 ? 'danger' : 'muted'} />
          <Metric label="In queue" value={progress.PENDING + progress.PROCESSING} tone="muted" />
          {data.imageKinds.AI_GENERATED ? (
            <span className="flex items-center gap-1.5">
              <ImageKindBadge kind="AI_GENERATED" />
              <span className="text-muted">{data.imageKinds.AI_GENERATED.toLocaleString()}</span>
            </span>
          ) : null}
        </div>

        {progress.isRunning ? (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-soft0 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            Processing — this page updates itself.
          </p>
        ) : null}
      </Card>

      {/* Exports */}
      {data.exports.length > 0 ? (
        <Card>
          <CardHeader title="Downloads" />
          <ul className="divide-y divide-line-soft">
            {data.exports.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">{item.fileName}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {item.status === 'READY'
                      ? `${item.imageCount.toLocaleString()} images · ${formatBytes(item.bytes)} · ${formatDate(item.createdAt)}`
                      : item.status === 'FAILED'
                        ? (item.errorMessage ?? 'Build failed')
                        : 'Building…'}
                  </p>
                </div>
                {item.downloadUrl ? (
                  <a
                    href={item.downloadUrl}
                    className="text-sm font-medium text-accent hover:text-accent"
                  >
                    Download
                  </a>
                ) : (
                  <Badge tone={item.status === 'FAILED' ? 'danger' : 'accent'}>
                    {item.status === 'FAILED' ? 'Failed' : 'Building'}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* Products */}
      <Card>
        <CardHeader
          title="Products"
          description={products ? `${products.total.toLocaleString()} shown` : undefined}
          action={
            <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
              {TABS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => {
                    setTab(entry.key);
                    setPage(1);
                  }}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-medium transition',
                    tab === entry.key ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          }
        />

        {!products ? (
          <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="aspect-square animate-pulse rounded-lg bg-surface-2" />
            ))}
          </div>
        ) : products.products.length === 0 ? (
          <EmptyState
            title="Nothing to show"
            description={
              tab === 'FAILED'
                ? 'No products failed in this batch.'
                : 'No products match this filter yet.'
            }
          />
        ) : (
          <>
            <ul className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {products.products.map((product) => (
                <ProductCard key={product.id} product={product} />
              ))}
            </ul>

            {products.totalPages > 1 ? (
              <div className="flex items-center justify-between border-t border-line-soft px-5 py-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                >
                  Previous
                </Button>
                <p className="text-sm text-muted">
                  Page {products.page} of {products.totalPages}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(products.totalPages, p + 1))}
                  disabled={page >= products.totalPages}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'positive' | 'danger' | 'muted';
}) {
  const colour =
    tone === 'positive' ? 'text-positive' : tone === 'danger' ? 'text-danger' : 'text-muted';
  return (
    <span className="flex items-baseline gap-1.5">
      <span className={cn('font-semibold tabular-nums', colour)}>{value.toLocaleString()}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}

function ProductCard({ product }: { product: ProductRow }) {
  const transparent = product.image?.fileName.endsWith('.png');

  return (
    <li className="overflow-hidden rounded-xl border border-line bg-surface">
      <div
        className={cn(
          'relative flex aspect-square items-center justify-center overflow-hidden bg-canvas',
          transparent && 'alpha-grid',
        )}
      >
        {product.image ? (
          // eslint-disable-next-line @next/next/no-img-element -- images are
          // user-scoped and streamed from our own API, so the optimizer adds
          // nothing but a second copy of every asset.
          <img
            src={`/api/images/${product.image.id}/file`}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-contain"
          />
        ) : product.status === 'FAILED' ? (
          <div className="px-4 text-center">
            <svg viewBox="0 0 24 24" fill="none" className="mx-auto h-6 w-6 text-danger">
              <path
                d="M12 8v5m0 3h.01M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        ) : (
          <div className="h-full w-full animate-pulse bg-surface-2" />
        )}

        {product.image ? (
          <div className="absolute left-2 top-2">
            <ImageKindBadge kind={product.image.kind} />
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 text-sm font-medium leading-snug text-fg" title={product.name}>
            {product.name}
          </p>
          <ProductStatusBadge status={product.status} />
        </div>

        <p className="truncate font-mono text-[11px] text-muted">
          {product.outputName ?? product.sku ?? product.upc ?? `Row ${product.rowNumber}`}
        </p>

        {product.image ? (
          <p className="text-[11px] text-muted">
            {product.image.width}×{product.image.height} · {formatBytes(product.image.bytes)}
            {product.image.provider ? ` · ${product.image.provider}` : ''}
          </p>
        ) : null}

        {product.errorMessage ? (
          <p className="line-clamp-2 text-[11px] leading-snug text-danger" title={product.errorMessage}>
            {product.errorMessage}
          </p>
        ) : null}
      </div>
    </li>
  );
}
