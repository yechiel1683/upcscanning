'use client';

import { useState } from 'react';

import { cn } from '@/components/ui';
import { BarcodeClient } from './barcode-client';
import { UploadClient } from './upload-client';

type Mode = 'file' | 'barcodes';

const MODES: Array<{ key: Mode; label: string; hint: string }> = [
  { key: 'file', label: 'Spreadsheet', hint: 'CSV or Excel with product columns' },
  { key: 'barcodes', label: 'Barcode list', hint: 'Just paste UPCs, one per line' },
];

export function UploadModeSwitch() {
  const [mode, setMode] = useState<Mode>('file');

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label="How to provide your products"
        className="grid gap-2 sm:grid-cols-2"
      >
        {MODES.map((entry) => {
          const active = mode === entry.key;
          return (
            <button
              key={entry.key}
              role="tab"
              type="button"
              aria-selected={active}
              onClick={() => setMode(entry.key)}
              className={cn(
                'rounded-xl border px-4 py-3 text-left transition',
                active
                  ? 'border-accent bg-accent-soft ring-1 ring-accent'
                  : 'border-line bg-surface hover:bg-canvas',
              )}
            >
              <span
                className={cn(
                  'block text-sm font-semibold',
                  active ? 'text-accent' : 'text-fg',
                )}
              >
                {entry.label}
              </span>
              <span className="mt-0.5 block text-xs text-muted">{entry.hint}</span>
            </button>
          );
        })}
      </div>

      {mode === 'file' ? <UploadClient /> : <BarcodeClient />}
    </div>
  );
}
