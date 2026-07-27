'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import {
  BACKGROUNDS,
  DEFAULT_RENDER_OPTIONS,
  OUTPUT_FORMATS,
  type BackgroundStyle,
  type OutputFormat,
} from '@/lib/types';
import { Button, Card, CardHeader, Field, inputClass } from '@/components/ui';

/**
 * Paste-a-list-of-barcodes entry point.
 *
 * No column mapping step, because there are no columns — the pipeline resolves
 * each barcode to a real product and fills the details in on the way through.
 */

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

const PLACEHOLDER = `036000291452
885911574518
5449000000996

You can also paste two columns:
190199098701, Apple AirPods Pro`;

export function BarcodeClient() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
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

  // A local count so the button can state the cost before anything is sent.
  const count = useMemo(() => {
    const seen = new Set<string>();
    for (const line of text.split(/\r?\n/)) {
      const digits = (line.split(/[,\t;|]/)[0] ?? '').replace(/\D/g, '');
      if (digits.length >= 8) seen.add(digits);
    }
    return seen.size;
  }, [text]);

  async function submit() {
    if (count === 0) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ barcodes: text, options }),
      });

      const data = (await response.json().catch(() => ({}))) as {
        batch?: { id: string };
        error?: string;
      };

      if (!response.ok || !data.batch) {
        setError(data.error ?? 'We could not start that batch.');
        setBusy(false);
        return;
      }

      router.push(`/dashboard/batches/${data.batch.id}`);
      router.refresh();
    } catch {
      setError('The request did not reach the server. Check your connection and try again.');
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="Paste your barcodes"
          description="One UPC, EAN, or GTIN per line. We look up what each one is, then find its photo."
        />
        <div className="space-y-4 p-5">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={12}
            spellCheck={false}
            placeholder={PLACEHOLDER}
            aria-label="Barcodes, one per line"
            className={`${inputClass} resize-y font-mono text-sm`}
          />

          <p className="text-sm text-ink-500">
            {count === 0
              ? 'No barcodes detected yet.'
              : `${count.toLocaleString()} barcode${count === 1 ? '' : 's'} detected.`}
          </p>

          {error ? (
            <p role="alert" className="rounded-lg bg-danger-100 px-3 py-2 text-sm text-danger-600">
              {error}
            </p>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Output" description="These settings apply to every image in the batch." />
        <div className="grid gap-5 p-5 sm:grid-cols-2">
          <Field label="Image size" htmlFor="bc-size">
            <select
              id="bc-size"
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

          <Field label="Background" htmlFor="bc-background">
            <select
              id="bc-background"
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
            htmlFor="bc-format"
            hint={
              options.background === 'transparent' && options.format === 'jpeg'
                ? 'JPEG cannot hold transparency — these will be saved as PNG.'
                : undefined
            }
          >
            <select
              id="bc-format"
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
              hint="Barcodes with no findable photo get an AI-generated one, clearly labelled."
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

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 px-5 py-4">
          <p className="text-sm text-ink-500">
            {count > 0 ? (
              <>
                This will use{' '}
                <span className="font-medium text-ink-900">
                  {count.toLocaleString()} credit{count === 1 ? '' : 's'}
                </span>
                , one per barcode.
              </>
            ) : (
              'Paste some barcodes to continue.'
            )}
          </p>
          <Button onClick={() => void submit()} disabled={count === 0 || busy}>
            {busy ? 'Starting…' : `Process ${count.toLocaleString()} barcode${count === 1 ? '' : 's'}`}
          </Button>
        </div>
      </Card>
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
        className="mt-0.5 h-4 w-4 rounded border-ink-200 text-accent-600 focus:ring-accent-600"
      />
      <span>
        <span className="block text-sm font-medium text-ink-800">{label}</span>
        <span className="block text-xs text-ink-500">{hint}</span>
      </span>
    </label>
  );
}
