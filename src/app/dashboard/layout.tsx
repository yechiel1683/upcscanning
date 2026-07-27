import Link from 'next/link';
import { redirect } from 'next/navigation';

import { currentUser } from '@/server/auth/session';
import { DashboardNav, SignOutButton } from './nav';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="flex items-center gap-2.5">
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
              <span className="hidden text-sm font-semibold tracking-tight text-ink-900 sm:block">
                CatalogForge
              </span>
            </Link>
            <DashboardNav />
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-xs font-medium text-ink-900">{user.name ?? user.email}</p>
              <p className="text-xs text-ink-500">
                {user.credits.toLocaleString()} credit{user.credits === 1 ? '' : 's'}
              </p>
            </div>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
