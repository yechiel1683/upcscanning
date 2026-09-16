'use client';

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/components/ui';

/**
 * Six boxes for a six-digit code.
 *
 * The details are the whole point of building this rather than using a text
 * field, and each one exists because of how people actually enter these:
 *
 *  - Pasting the whole code fills every box. Most people copy it out of the
 *    email, and a paste that lands entirely in the first box is the single
 *    most common way one of these feels broken.
 *  - Typing advances; backspace on an empty box goes back. Without that,
 *    correcting a typo means clicking.
 *  - `inputMode="numeric"` and `autoComplete="one-time-code"` mean a phone
 *    shows the number pad and iOS offers the code from the notification, so
 *    the whole thing becomes one tap.
 *  - Non-digits are dropped on the way in rather than rejected afterwards,
 *    because an error message for typing a space is a pointless one.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  disabled,
  invalid,
  length = 6,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Fired when the last box is filled, so nobody hunts for a submit button. */
  onComplete?: (code: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  length?: number;
}) {
  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const [focused, setFocused] = useState<number | null>(null);

  // Land in the first box so the code can be typed immediately.
  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  function setAt(index: number, digits: string) {
    const cleaned = digits.replace(/\D/g, '');
    if (!cleaned) return;

    // One character types; several is a paste, and fills forward from here.
    const next = (value.padEnd(length, ' ').split('') as string[]).map((char) =>
      char === ' ' ? '' : char,
    );
    for (let i = 0; i < cleaned.length && index + i < length; i += 1) {
      next[index + i] = cleaned[i]!;
    }
    const joined = next.join('').slice(0, length);
    onChange(joined);

    const landed = Math.min(index + cleaned.length, length - 1);
    inputs.current[landed]?.focus();

    if (joined.length === length) onComplete?.(joined);
  }

  function onKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const next = value.split('');
      if (next[index]) {
        next[index] = '';
        onChange(next.join('').trimEnd());
      } else if (index > 0) {
        // Empty box: clear the one before and move there, which is what
        // backspace does everywhere else.
        next[index - 1] = '';
        onChange(next.join('').trimEnd());
        inputs.current[index - 1]?.focus();
      }
    } else if (event.key === 'ArrowLeft' && index > 0) {
      inputs.current[index - 1]?.focus();
    } else if (event.key === 'ArrowRight' && index < length - 1) {
      inputs.current[index + 1]?.focus();
    }
  }

  return (
    <div className="flex justify-center gap-2 sm:gap-2.5" role="group" aria-label="Confirmation code">
      {Array.from({ length }, (_, index) => {
        const char = value[index] ?? '';
        return (
          <input
            key={index}
            ref={(node) => {
              inputs.current[index] = node;
            }}
            id={index === 0 ? 'code' : undefined}
            value={char}
            disabled={disabled}
            inputMode="numeric"
            // Only the first box claims it, or some browsers scatter the code.
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            aria-label={`Digit ${index + 1} of ${length}`}
            aria-invalid={invalid || undefined}
            maxLength={length}
            onChange={(event) => setAt(index, event.target.value)}
            onKeyDown={(event) => onKeyDown(index, event)}
            onFocus={(event) => {
              setFocused(index);
              event.target.select();
            }}
            onBlur={() => setFocused(null)}
            className={cn(
              'h-14 w-11 rounded-xl border bg-surface text-center font-mono text-2xl',
              'text-fg tabular-nums outline-none transition',
              'sm:h-16 sm:w-14',
              invalid
                ? 'border-danger'
                : focused === index
                  ? 'border-accent ring-2 ring-accent-line'
                  : char
                    ? 'border-line'
                    : 'border-line-soft',
              disabled && 'opacity-60',
            )}
          />
        );
      })}
    </div>
  );
}
