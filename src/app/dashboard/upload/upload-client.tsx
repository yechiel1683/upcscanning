'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';

import {
  BACKGROUNDS,
  CANONICAL_FIELDS,
  DEFAULT_RENDER_OPTIONS,
  OUTPUT_FORMATS,
  type BackgroundStyle,
  type CanonicalField,
  type ColumnMapping,
  type OutputFormat,
  type ParsedProduct,
} from '@/lib/types';
import { Badge, Button, Card, CardHeader, cn, Field, formatBytes, inputClass } from '@/components/ui';

/**
 * Upload is deliberately two steps: parse-and-confirm, then commit.
 *
 * Getting the column mapping wrong on a 2,000-row list wastes the customer's
 * credits and their afternoon, so the preview is not optional — it is the part
 * that makes bulk processing safe.
 */

interface PreviewResponse {
  fileName: string;
  fileSizeBytes: number;
  headers: string[];
  mapping: ColumnMapping;
  unmappedHeaders: string[];
  usable: boolean;
  totalRows: number;
  productCount: number;
  skippedCount: number;
  sample: ParsedProduct[];
  skipped: Array<{ rowNumber: number; message: string }>;
  warnings: Array<{ rowNumber: number; message: string }>;
}

const FIELD_LABELS: Record<CanonicalField, string> = {
  sku: 'SKU / item number',
  upc: 'UPC / barcode',
  name: 'Product name',
  brand: 'Brand',
  model: 'Model number',
  description: 'Description',
  specifications: 'Specifications',
  category: 'Category',
  price: 'Price',
  imageUrl: 'Existing image URL',
};

const BACKGROUND_LABELS: Record<BackgroundStyle, string> = {
  white: 'Pure white',
  transparent: 'Transparent',
  'light-gray': 'Light grey',
  studio: 'Studio sweep',
};

const SIZE_PRESETS = [
  { label: '1600 × 1600 — Amazon / Shopify', width: 1600, height: 1600 },
  { label: '2000 × 2000 — high resolution', width: 2000, height: 2000 },
  { label: '1200 × 1200 — web catalog', width: 1200, height: 1200 },
  { label: '1000 × 1000 — marketplace minimum', width: 1000, height: 1000 },
];

export function UploadClient() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'submit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [options, setOptions] = useState({
    width: DEFAULT_RENDER_OPTIONS.width,
    height: DEFAULT_RENDER_OPTIONS.height,
    background: DEFAULT_RENDER_OPTIONS.background as BackgroundStyle,
    format: DEFAULT_RENDER_OPTIONS.format as OutputFormat,
    removeBackground: DEFAULT_RENDER_OPTIONS.removeBackground,
    dropShadow: DEFAULT_RENDER_OPTIONS.dropShadow,
    allowAiGeneration: DEFAULT_RENDER_OPTIONS.allowAiGeneration,
    watermarkAiImages: DEFAULT_RENDER_OPTIONS.watermarkAiImages,
  });

  const runPreview = useCallback(async (selected: File, overrides?: ColumnMapping) => {
    setBusy('preview');
    setError(null);

    const body = new FormData();
    body.append('file', selected);
    if (overrides && Object.keys(overrides).length > 0) {
      body.append('mapping', JSON.stringify(overrides));
    }

    try {
      const response = await fetch('/api/uploads/preview', { method: 'POST', body });
      const data = (await response.json().catch(() => ({}))) as PreviewResponse & { error?: string };

      if (!response.ok) {
        setError(data.error ?? 'We could not read that file.');
        setPreview(null);
        return;
      }

      setPreview(data);
      setMapping(data.mapping);
    } catch {
      setError('The upload did not reach the server. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }, []);

  function selectFile(next: File | null) {
    setFile(next);
    setPreview(null);
    setMapping({});
    setError(null);
    if (next) void runPreview(next);
  }

  function updateMapping(field: CanonicalField, header: string) {
    const next: ColumnMapping = { ...mapping };
    if (header === '') delete next[field];
    else next[field] = header;
    setMapping(next);
  }

  async function submit() {
    if (!file) return;
    setBusy('submit');
    setError(null);

    const body = new FormData();
    body.append('file', file);
    body.append('mapping', JSON.stringify(mapping));
    body.append('options', JSON.stringify(options));

    try {
      const response = await fetch('/api/batches', { method: 'POST', body });
      const data = (await response.json().catch(() => ({}))) as {
        batch?: { id: string };
        error?: string;
      };

      if (!response.ok || !data.batch) {
        setError(data.error ?? 'We could not start that batch.');
        setBusy(null);
        return;
      }

      router.push(`/dashboard/batches/${data.batch.id}`);
      router.refresh();
    } catch {
      setError('The upload did not reach the server. Check your connection and try again.');
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Step 1 — the file */}
      <Card>
        <CardHeader
          title="1. Choose your product list"
          description="CSV, XLSX, or XLSM. Up to 5,000 products per upload."
        />
        <div className="p-5">
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
              if (dropped) selectFile(dropped);
            }}
            className={cn(
              'rounded-xl border-2 border-dashed px-6 py-10 text-center transition',
              dragging ? 'border-accent bg-accent-soft' : 'border-line bg-canvas',
            )}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xls"
              className="sr-only"
              onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
            />

            {file ? (
              <div className="space-y-3">
                <p className="text-sm font-medium text-fg">{file.name}</p>
                <p className="text-xs text-muted">{formatBytes(file.size)}</p>
                <div className="flex justify-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()}>
                    Choose a different file
                  </Button>
                  {preview ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void runPreview(file, mapping)}
                      disabled={busy !== null}
                    >
                      Re-read with this mapping
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <svg viewBox="0 0 24 24" fill="none" className="mx-auto h-8 w-8 text-subtle">
                  <path
                    d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <p className="text-sm text-muted">
                  Drag your spreadsheet here, or{' '}
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className="font-medium text-accent underline-offset-2 hover:underline"
                  >
                    browse for it
                  </button>
                </p>
                <p className="text-xs text-muted">
                  We read the headers first and show you what we found before anything runs.
                </p>
              </div>
            )}
          </div>

          {busy === 'preview' ? (
            <p className="mt-4 text-sm text-muted">Reading the file…</p>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </Card>

      {preview ? (
        <>
          {/* Step 2 — mapping */}
          <Card>
            <CardHeader
              title="2. Check the columns"
              description={`${preview.productCount.toLocaleString()} products found in ${preview.totalRows.toLocaleString()} rows.`}
              action={
                preview.usable ? (
                  <Badge tone="positive">Ready</Badge>
                ) : (
                  <Badge tone="danger">Needs a name or barcode</Badge>
                )
              }
            />

            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {CANONICAL_FIELDS.map((field) => (
                <Field key={field} label={FIELD_LABELS[field]} htmlFor={`map-${field}`}>
                  <select
                    id={`map-${field}`}
                    className={inputClass}
                    value={mapping[field] ?? ''}
                    onChange={(event) => updateMapping(field, event.target.value)}
                  >
                    <option value="">— not in this file —</option>
                    {preview.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>

            {preview.unmappedHeaders.length > 0 ? (
              <div className="border-t border-line-soft px-5 py-3">
                <p className="text-xs text-muted">
                  Kept but not used for matching:{' '}
                  <span className="text-muted">{preview.unmappedHeaders.join(', ')}</span>
                </p>
              </div>
            ) : null}

            {preview.sample.length > 0 ? (
              <div className="overflow-x-auto border-t border-line-soft">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-canvas text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-5 py-2.5 font-medium">Row</th>
                      <th className="px-5 py-2.5 font-medium">Product</th>
                      <th className="px-5 py-2.5 font-medium">Brand</th>
                      <th className="px-5 py-2.5 font-medium">UPC</th>
                      <th className="px-5 py-2.5 font-medium">SKU</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {preview.sample.map((product) => (
                      <tr key={product.rowNumber}>
                        <td className="px-5 py-2.5 font-mono text-xs text-subtle">{product.rowNumber}</td>
                        <td className="max-w-xs truncate px-5 py-2.5 text-fg">{product.name}</td>
                        <td className="px-5 py-2.5 text-muted">{product.brand ?? '—'}</td>
                        <td className="px-5 py-2.5 font-mono text-xs text-muted">{product.upc ?? '—'}</td>
                        <td className="px-5 py-2.5 font-mono text-xs text-muted">{product.sku ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {preview.skipped.length > 0 || preview.warnings.length > 0 ? (
              <div className="space-y-2 border-t border-line-soft px-5 py-4">
                {preview.skippedCount > 0 ? (
                  <p className="text-sm text-muted">
                    <span className="font-medium text-fg">
                      {preview.skippedCount.toLocaleString()} row
                      {preview.skippedCount === 1 ? '' : 's'} skipped.
                    </span>{' '}
                    {preview.skipped[0]?.message}
                    {preview.skipped.length > 1 ? ` (+${preview.skipped.length - 1} more)` : ''}
                  </p>
                ) : null}
                {preview.warnings.slice(0, 3).map((warning) => (
                  <p key={`${warning.rowNumber}-${warning.message}`} className="text-xs text-warning">
                    Row {warning.rowNumber}: {warning.message}
                  </p>
                ))}
              </div>
            ) : null}
          </Card>

          {/* Step 3 — output */}
          <Card>
            <CardHeader
              title="3. Choose the output"
              description="These settings apply to every image in the batch."
            />
            <div className="grid gap-5 p-5 sm:grid-cols-2">
              <Field label="Image size" htmlFor="size">
                <select
                  id="size"
                  className={inputClass}
                  value={`${options.width}x${options.height}`}
                  onChange={(event) => {
                    const [width, height] = event.target.value.split('x').map(Number);
                    setOptions((o) => ({ ...o, width: width ?? 1600, height: height ?? 1600 }));
                  }}
                >
                  {SIZE_PRESETS.map((preset) => (
                    <option key={preset.label} value={`${preset.width}x${preset.height}`}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Background" htmlFor="background">
                <select
                  id="background"
                  className={inputClass}
                  value={options.background}
                  onChange={(event) =>
                    setOptions((o) => ({ ...o, background: event.target.value as BackgroundStyle }))
                  }
                >
                  {BACKGROUNDS.map((background) => (
                    <option key={background} value={background}>
                      {BACKGROUND_LABELS[background]}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="File format"
                htmlFor="format"
                hint={
                  options.background === 'transparent' && options.format === 'jpeg'
                    ? 'JPEG cannot hold transparency — these will be saved as PNG.'
                    : undefined
                }
              >
                <select
                  id="format"
                  className={inputClass}
                  value={options.format}
                  onChange={(event) =>
                    setOptions((o) => ({ ...o, format: event.target.value as OutputFormat }))
                  }
                >
                  {OUTPUT_FORMATS.map((format) => (
                    <option key={format} value={format}>
                      {format.toUpperCase()}
                    </option>
                  ))}
                </select>
              </Field>

              <div className="space-y-2.5">
                <Toggle
                  label="Remove the background"
                  hint="Cut the product out and place it on your chosen backdrop."
                  checked={options.removeBackground}
                  onChange={(v) => setOptions((o) => ({ ...o, removeBackground: v }))}
                />
                <Toggle
                  label="Add a contact shadow"
                  hint="A soft shadow under the product so it sits on the surface."
                  checked={options.dropShadow}
                  onChange={(v) => setOptions((o) => ({ ...o, dropShadow: v }))}
                />
                <Toggle
                  label="Generate images when none exist"
                  hint="Products with no findable photo get an AI-generated one, clearly labelled."
                  checked={options.allowAiGeneration}
                  onChange={(v) => setOptions((o) => ({ ...o, allowAiGeneration: v }))}
                />
                {options.allowAiGeneration ? (
                  <Toggle
                    label="Watermark AI-generated images"
                    hint="Stamps a small corner badge onto generated images."
                    checked={options.watermarkAiImages}
                    onChange={(v) => setOptions((o) => ({ ...o, watermarkAiImages: v }))}
                  />
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft px-5 py-4">
              <p className="text-sm text-muted">
                This will use{' '}
                <span className="font-medium text-fg">
                  {preview.productCount.toLocaleString()} credit
                  {preview.productCount === 1 ? '' : 's'}
                </span>
                , one per product.
              </p>
              <Button onClick={() => void submit()} disabled={!preview.usable || busy !== null}>
                {busy === 'submit' ? 'Starting…' : `Process ${preview.productCount.toLocaleString()} products`}
              </Button>
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-line text-accent focus:ring-accent"
      />
      <span>
        <span className="block text-sm font-medium text-fg">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}
