import Link from 'next/link';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-ink-50">
      <header className="mx-auto w-full max-w-6xl px-6 py-5">
        <Link href="/" className="inline-flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-600 text-white"
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4">
              <path
                d="M3 5.5A2.5 2.5 0 0 1 5.5 3h9A2.5 2.5 0 0 1 17 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 3 14.5v-9Z"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="M3.5 13.5 7 10l3 3 3-2.5 3.5 3"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="text-base font-semibold tracking-tight text-ink-900">CatalogForge</span>
        </Link>
      </header>

      <main className="flex flex-1 items-start justify-center px-6 pb-20 pt-4 sm:items-center sm:pt-0">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
