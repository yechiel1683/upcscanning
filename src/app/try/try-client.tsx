'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ImageKindBadge, ProductStatusBadge } from '@/components/status';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  cn,
  formatBytes,
  inputClass,
  ProgressBar,
} from '@/components/ui';

/**
 * The guest workspace: upload, watch, download — no account, no database.
 *
 * It drives the same pipeline an account uses. The only differences are where
 * results are kept (memory, for a few hours) and how much you may run.
 */

interface GuestInfo {
  credits: number;
  maxProductsPerBatch: number;
  startingCredits: number;
}

interface Capabilities {
  barcodeLookup: { count: number; providers: string[] };
  webSearch: { enabled: boolean; providers: string[] };
  generation: { enabled: boolean; provider: string | null };
  fullyConfigured: boolean;
}

interface GuestImage {
  id: string;
  kind: string;
  fileName: string;
  width: number;
  height: number;
  bytes: number;
  provider: string | null;
}

/** Another picture of the same product that was also a real contender. */
interface Alternative {
  sourceUrl: string;
  provider: string;
  matchScore: number;
  qualityScore: number;
}

interface GuestProduct {
  id: string;
  rowNumber: number;
  sku: string | null;
  upc: string | null;
  name: string;
  brand: string | null;
  status: string;
  errorMessage: string | null;
  reviewReason?: string | null;
  attempts?: number;
  alternatives?: Alternative[];
  outputName: string | null;
  detailsSource: string | null;
  image: GuestImage | null;
}

interface BatchState {
  batch: { id: string; name: string; status: string };
  progress: {
    total: number;
    finished: number;
    percent: number;
    SUCCEEDED: number;
    NEEDS_REVIEW: number;
    FAILED: number;
    isRunning: boolean;
  };
  credits: number;
  products: GuestProduct[];
}

const SAMPLE_BARCODES = `036000291452
885911574518
5449000000996`;

export function TryClient() {
  const [info, setInfo] = useState<GuestInfo | null>(null);
  const [mode, setMode] = useState<'barcodes' | 'file'>('barcodes');
  const [barcodes, setBarcodes] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<BatchState | null>(null);
  /** Which row is mid-decision, so a swap that has to render says so. */
  const [deciding, setDeciding] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Ensure a session exists so the credit allowance can be shown up front.
    void fetch('/api/guest/session', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setInfo(d.guest))
      .catch(() => {});

    void fetch('/api/guest/capabilities')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setCaps(d))
      .catch(() => {});
  }, []);

  const count = barcodes
    .split(/\r?\n/)
    .map((line) => (line.split(/[,\t;|]/)[0] ?? '').replace(/\D/g, ''))
    .filter((digits) => digits.length >= 8).length;

  const poll = useCallback(async (id: string) => {
    const response = await fetch(`/api/guest/batches/${id}`, { cache: 'no-store' });
    if (!response.ok) return null;
    const data = (await response.json()) as BatchState;
    setState(data);
    setInfo((prev) => (prev ? { ...prev, credits: data.credits } : prev));
    return data;
  }, []);

  /**
   * Check often at first, then ease off.
   *
   * A fixed two-second interval put up to two seconds of pure waiting between a
   * barcode being finished and being visible — on work that now takes about
   * that long in total, so half the wait was the page not looking. A single
   * barcode is usually done before the second check, and a long batch does not
   * need to be asked four times a second, so the interval starts at 300ms and
   * grows towards two seconds.
   */
  useEffect(() => {
    if (!state?.progress.isRunning) return;
    const id = state.batch.id;
    let cancelled = false;
    let delay = 300;
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      void poll(id).then((next) => {
        if (cancelled) return;
        if (next && !next.progress.isRunning) return;
        delay = Math.min(Math.round(delay * 1.4), 2000);
        timer = setTimeout(tick, delay);
      });
    };
    timer = setTimeout(tick, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state?.progress.isRunning, state?.batch.id, poll]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const response =
        mode === 'barcodes'
          ? await fetch('/api/guest/batches', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ barcodes }),
            })
          : await (() => {
              const body = new FormData();
              body.append('file', file as File);
              return fetch('/api/guest/batches', { method: 'POST', body });
            })();

      const data = (await response.json().catch(() => ({}))) as {
        batch?: { id: string };
        error?: string;
      };

      if (!response.ok || !data.batch) {
        setError(data.error ?? 'We could not start that batch.');
        return;
      }
      await poll(data.batch.id);
    } catch {
      setError('The request did not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Settle a row the pipeline was not confident about: keep this image, swap to
   * the other candidate, or reject it.
   */
  async function decide(productId: string, choice: { accept: boolean; use?: string }) {
    setDeciding(productId);
    try {
      await fetch(`/api/guest/products/${productId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(choice),
      });
    } catch {
      // A failed confirmation is recoverable by pressing the button again;
      // the refresh below shows whichever state actually took.
    } finally {
      setDeciding(null);
    }
    if (state) await poll(state.batch.id);
  }

  const canStart = mode === 'barcodes' ? count > 0 : Boolean(file);

  return (
    <div className="space-y-6">
      <Card className="border-accent-line bg-accent-soft">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-semibold text-fg">Guest session</p>
            <p className="mt-0.5 text-sm text-muted">
              The real pipeline, with nothing saved on the server. Download your ZIP before
              you leave — it is the only copy.
            </p>
          </div>
          {info ? (
            <Badge tone="accent">
              {info.credits} of {info.startingCredits} images left
            </Badge>
          ) : null}
        </div>
      </Card>

      {caps && !caps.fullyConfigured ? (
        <Card className="border-warning/40 bg-warning-soft">
          <div className="p-4">
            <p className="text-sm font-semibold text-fg">
              This instance is only partly set up
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              {`Only ${caps.barcodeLookup.count} free barcode database(s) can look for photographs, so products they do not carry will come back empty.`}{' '}
              Set{' '}
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-fg">
                OPENAI_API_KEY
              </code>{' '}
              on the server to search the open web as well.
            </p>
            {/* Setting the variable and still seeing this banner is the loop the
                setup page exists to break, so it has to be reachable from here. */}
            <a
              href="/setup"
              className="mt-3 inline-flex text-sm font-medium text-fg underline underline-offset-4 hover:opacity-80"
            >
              Already set it? Check why it isn’t arriving →
            </a>
          </div>
        </Card>
      ) : null}

      {!state ? (
        <Card>
          <CardHeader
            title="Try it on your products"
            description={
              info
                ? `Up to ${info.maxProductsPerBatch} products per batch in a guest session.`
                : undefined
            }
            action={
              <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
                {(['barcodes', 'file'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setMode(key)}
                    className={cn(
                      'rounded-md px-3 py-1 text-xs font-medium transition',
                      mode === key
                        ? 'bg-surface text-fg shadow-card'
                        : 'text-muted hover:text-fg',
                    )}
                  >
                    {key === 'barcodes' ? 'Barcodes' : 'Spreadsheet'}
                  </button>
                ))}
              </div>
            }
          />

          <div className="space-y-4 p-5">
            {mode === 'barcodes' ? (
              <>
                <textarea
                  value={barcodes}
                  onChange={(event) => setBarcodes(event.target.value)}
                  rows={8}
                  spellCheck={false}
                  placeholder={SAMPLE_BARCODES}
                  aria-label="Barcodes, one per line"
                  className={`${inputClass} resize-y font-mono text-sm`}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-muted">
                    {count === 0 ? 'One UPC, EAN, or GTIN per line.' : `${count} detected.`}
                  </p>
                  {count === 0 ? (
                    <button
                      type="button"
                      onClick={() => setBarcodes(SAMPLE_BARCODES)}
                      className="text-sm font-medium text-accent hover:text-accent-hover"
                    >
                      Use sample barcodes
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  const dropped = event.dataTransfer.files?.[0];
                  if (dropped) setFile(dropped);
                }}
                className={cn(
                  'rounded-xl border-2 border-dashed px-6 py-10 text-center transition',
                  dragging ? 'border-accent bg-accent-soft' : 'border-line bg-surface-2',
                )}
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.tsv,.txt,.xlsx,.xlsm"
                  className="sr-only"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                {file ? (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-fg">{file.name}</p>
                    <p className="text-xs text-muted">{formatBytes(file.size)}</p>
                    <Button variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                      Choose a different file
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-muted">
                    Drag a CSV or Excel file here, or{' '}
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      className="font-medium text-accent underline-offset-2 hover:underline"
                    >
                      browse for it
                    </button>
                  </p>
                )}
              </div>
            )}

            {error ? (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-end border-t border-line-soft px-5 py-4">
            <Button onClick={() => void start()} disabled={!canStart || busy}>
              {busy ? 'Starting…' : 'Find product images'}
            </Button>
          </div>
        </Card>
      ) : (
        <Results
          state={state}
          deciding={deciding}
          onDecide={(id, choice) => void decide(id, choice)}
          onReset={() => { setState(null); setBarcodes(''); setFile(null); }}
        />
      )}
    </div>
  );
}

function Results({
  state,
  onReset,
  onDecide,
  deciding,
}: {
  state: BatchState;
  onReset: () => void;
  onDecide: (productId: string, choice: { accept: boolean; use?: string }) => void;
  deciding: string | null;
}) {
  const { progress } = state;
  const done = !progress.isRunning;
  // A row awaiting a decision has an image. Counting only SUCCEEDED understated
  // the result and, when every image needed a look, hid the download entirely.
  const withImages = progress.SUCCEEDED + progress.NEEDS_REVIEW;

  return (
    <div className="space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-fg">
            {progress.finished} of {progress.total} processed
          </p>
          <p className="text-sm text-muted">{progress.percent}%</p>
        </div>
        <div className="mt-2.5">
          <ProgressBar
            percent={progress.percent}
            tone={done && progress.FAILED > 0 ? 'danger' : 'accent'}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <span className="text-sm">
            <span className="font-semibold text-positive">{withImages}</span>{' '}
            <span className="text-muted">images</span>
          </span>
          {progress.NEEDS_REVIEW > 0 ? (
            <span className="text-sm">
              <span className="font-semibold text-warning">{progress.NEEDS_REVIEW}</span>{' '}
              <span className="text-muted">to check</span>
            </span>
          ) : null}
          {progress.FAILED > 0 ? (
            <span className="text-sm">
              <span className="font-semibold text-danger">{progress.FAILED}</span>{' '}
              <span className="text-muted">failed</span>
            </span>
          ) : null}

          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="sm" onClick={onReset}>
              New batch
            </Button>
            {withImages > 0 ? (
              <a href={`/api/guest/batches/${state.batch.id}/export`}>
                <Button size="sm">Download ZIP</Button>
              </a>
            ) : null}
          </div>
        </div>

        {done && withImages === 0 && progress.FAILED > 0 ? (
          // Every product failing usually means one missing setting, not one
          // problem per product. Say it once, in full, instead of leaving the
          // reason truncated inside every card.
          <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm leading-relaxed text-danger">
            {state.products.find((product) => product.errorMessage)?.errorMessage}
          </p>
        ) : null}

        {progress.isRunning ? (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            Looking up products and finding images…
          </p>
        ) : null}
      </Card>

      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {state.products.map((product) => (
          <li key={product.id} className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="relative flex aspect-square items-center justify-center bg-surface-2">
              {product.image ? (
                // Served from memory by our own route; the optimizer adds
                // nothing here but a second copy of every asset.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`/api/guest/images/${product.image.id}/file`}
                  alt={product.name}
                  loading="lazy"
                  className="h-full w-full object-contain"
                />
              ) : product.status === 'FAILED' ? (
                <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-danger">
                  <path
                    d="M12 8v5m0 3h.01M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <div className="h-full w-full animate-pulse bg-surface-3" />
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
                {product.outputName ?? product.upc ?? product.sku ?? `Row ${product.rowNumber}`}
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
              {product.status === 'NEEDS_REVIEW' ? (
                <div className="space-y-2 rounded-lg bg-warning-soft p-2">
                  <p className="text-[11px] leading-snug text-fg">
                    {product.reviewReason ??
                      'This was the best that could be found. Check it before you use it.'}
                  </p>
                  {product.attempts && product.attempts > 1 ? (
                    <p className="text-[10px] text-muted">
                      Searched {product.attempts} times, widening each time.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      disabled={deciding === product.id}
                      onClick={() => onDecide(product.id, { accept: true })}
                    >
                      Looks right
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={deciding === product.id}
                      onClick={() => onDecide(product.id, { accept: false })}
                    >
                      Reject
                    </Button>
                  </div>

                  {/* The other picture that was in the running. Offered rather
                      than chosen, because when the scores are this close the
                      person filling the catalog judges better than the number
                      does. */}
                  {product.alternatives && product.alternatives.length > 0 ? (
                    <div className="space-y-1 border-t border-line pt-2">
                      <p className="text-[10px] font-medium text-muted">
                        {product.alternatives.length === 1
                          ? 'One other picture was found:'
                          : `${product.alternatives.length} other pictures were found:`}
                      </p>
                      {product.alternatives.map((option) => (
                        <button
                          key={option.sourceUrl}
                          type="button"
                          disabled={deciding === product.id}
                          onClick={() => onDecide(product.id, { accept: true, use: option.sourceUrl })}
                          className="flex w-full items-baseline justify-between gap-2 rounded px-1.5 py-1 text-left text-[11px] text-fg hover:bg-surface-2 disabled:opacity-60"
                        >
                          <span className="truncate">{option.provider}</span>
                          <span className="shrink-0 text-muted">
                            {deciding === product.id
                              ? 'Working…'
                              : `match ${option.matchScore.toFixed(2)} · use this`}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
