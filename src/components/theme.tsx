'use client';

import { useEffect, useState } from 'react';

import { cn } from './ui';

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'upcscanning-theme';

/**
 * Runs before first paint, so the page never flashes the wrong theme.
 *
 * This is inlined into <head> as a blocking script on purpose: React has not
 * hydrated yet, and a returning light-mode user must not see a black flash (or
 * the reverse). Dark is the default when nothing is stored.
 */
export const themeInitScript = `
(function(){
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var theme = stored === 'light' || stored === 'dark' ? stored : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

/** The theme currently applied to the document. */
export function readStoredTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** Apply and persist a theme. Shared by the header toggle and settings. */
export function setTheme(next: Theme): void {
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Private browsing can refuse storage; the change still applies to this
    // page view, which beats failing outright.
  }
}

export function ThemeToggle({ className }: { className?: string }) {
  // Start undefined so the server and the first client render agree; the real
  // value is read after mount, since only the DOM knows what the init script
  // decided.
  const [theme, setLocal] = useState<Theme | null>(null);

  useEffect(() => {
    setLocal(readStoredTheme());
  }, []);

  function toggle() {
    const next: Theme = readStoredTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setLocal(next);
  }

  const isDark = theme !== 'light';

  return (
    <button
      type="button"
      onClick={toggle}
      // The label is only meaningful once we know the current theme.
      aria-label={theme === null ? 'Toggle theme' : `Switch to ${isDark ? 'light' : 'dark'} theme`}
      title={theme === null ? 'Toggle theme' : `Switch to ${isDark ? 'light' : 'dark'} theme`}
      className={cn(
        'inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted transition',
        'hover:bg-surface-2 hover:text-fg',
        className,
      )}
    >
      {/* Both icons are rendered; CSS picks one, so the button is correct even
          before hydration tells us which theme is active. */}
      <SunIcon className="hidden h-[18px] w-[18px] dark-only" />
      <MoonIcon className="hidden h-[18px] w-[18px] light-only" />
      <style>{`
        :root[data-theme='dark'] .dark-only { display: block; }
        :root[data-theme='light'] .light-only { display: block; }
      `}</style>
    </button>
  );
}

function SunIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6 17 17M7 7 5.4 5.4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M20.5 14.2A8.6 8.6 0 0 1 9.8 3.5a8.6 8.6 0 1 0 10.7 10.7Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}
