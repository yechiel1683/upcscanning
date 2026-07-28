'use client';

import { useEffect, useState } from 'react';

import { cn } from '@/components/ui';
import { readStoredTheme, setTheme, type Theme } from '@/components/theme';

/**
 * Theme control for the settings page — the same preference the header toggle
 * writes, so the two can never disagree.
 */

const OPTIONS: Array<{ value: Theme; label: string; hint: string }> = [
  { value: 'dark', label: 'Black', hint: 'Default · #000000' },
  { value: 'light', label: 'White', hint: 'Clean · #ffffff' },
];

export function Appearance() {
  // Null until mounted: only the DOM knows what the init script chose, and
  // guessing would render the wrong option selected for a frame.
  const [theme, setLocal] = useState<Theme | null>(null);

  useEffect(() => {
    setLocal(readStoredTheme());
  }, []);

  return (
    <div className="p-5">
      <div
        role="radiogroup"
        aria-label="Theme"
        className="grid max-w-md gap-3 sm:grid-cols-2"
      >
        {OPTIONS.map((option) => {
          const active = theme === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setTheme(option.value);
                setLocal(option.value);
              }}
              className={cn(
                'flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition',
                active
                  ? 'border-accent ring-1 ring-accent'
                  : 'border-line hover:bg-surface-2',
              )}
            >
              {/* A literal swatch of the theme, so the choice is visible rather
                  than described. */}
              <span
                className={cn(
                  'h-9 w-9 shrink-0 rounded-lg ring-1 ring-inset',
                  option.value === 'dark'
                    ? 'bg-black ring-white/20'
                    : 'bg-white ring-black/15',
                )}
              />
              <span className="min-w-0">
                <span className={cn('block text-sm font-medium', active ? 'text-accent' : 'text-fg')}>
                  {option.label}
                </span>
                <span className="block text-xs text-muted">{option.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-muted">
        Saved in this browser. Black is the default for everyone who has not chosen.
      </p>
    </div>
  );
}
