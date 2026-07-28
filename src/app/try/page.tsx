import type { Metadata } from 'next';
import Link from 'next/link';

import { COMPANY, Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';
import { LinkButton } from '@/components/ui';
import { TryClient } from './try-client';

export const metadata: Metadata = { title: 'Try it' };
export const dynamic = 'force-dynamic';

export default function TryPage() {
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Wordmark />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link
              href="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-fg"
            >
              Sign in
            </Link>
            <LinkButton href="/register" size="sm">
              Create account
            </LinkButton>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Try it without an account</h1>
          <p className="mt-1 text-sm text-muted">
            Paste barcodes or drop a spreadsheet. Same pipeline, same output — just nothing
            kept on the server.
          </p>
        </div>

        <TryClient />
      </main>

      <footer className="border-t border-line px-6 py-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-1 text-xs text-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} {COMPANY}</p>
          <p>upcscanning.com</p>
        </div>
      </footer>
    </div>
  );
}
