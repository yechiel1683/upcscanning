import { Wordmark } from '@/components/brand';
import { COMPANY } from '@/components/brand';
import { ThemeToggle } from '@/components/theme';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
        <Wordmark />
        <ThemeToggle />
      </header>

      <main className="flex flex-1 items-start justify-center px-6 pb-16 pt-6 sm:items-center sm:pt-0">
        <div className="w-full max-w-sm">{children}</div>
      </main>

      <footer className="px-6 pb-8 text-center text-xs text-subtle">
        © {new Date().getFullYear()} {COMPANY}
      </footer>
    </div>
  );
}
