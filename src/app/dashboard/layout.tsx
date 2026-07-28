import { redirect } from 'next/navigation';

import { COMPANY, Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';
import { currentUser } from '@/server/auth/session';
import { DashboardNav, SignOutButton } from './nav';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login');

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-6">
            <Wordmark href="/dashboard" className="shrink-0" />
            <DashboardNav />
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden text-right sm:block">
              <p className="text-xs font-medium text-fg">{user.name ?? user.email}</p>
              <p className="text-xs text-muted">
                {user.credits.toLocaleString()} credit{user.credits === 1 ? '' : 's'}
              </p>
            </div>
            <ThemeToggle />
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">{children}</main>

      <footer className="border-t border-line px-6 py-6">
        <div className="mx-auto flex max-w-7xl flex-col gap-1 text-xs text-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} {COMPANY}</p>
          <p>upcscanning.com</p>
        </div>
      </footer>
    </div>
  );
}
