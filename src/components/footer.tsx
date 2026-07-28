import Link from 'next/link';

import { COMPANY, DOMAIN, Logo } from './brand';

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-line bg-canvas">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2.5">
              <Logo />
              <span className="text-[15px] font-semibold tracking-tight text-fg">
                UPC Scanning
              </span>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-muted">
              Barcodes in, professional product images out. Built for the people who get
              sent spreadsheets and asked for a catalog.
            </p>
          </div>

          <nav className="flex gap-12 text-sm">
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-subtle">
                Product
              </p>
              <ul className="mt-3 space-y-2">
                <li>
                  <Link href="/register" className="text-muted transition hover:text-fg">
                    Get started
                  </Link>
                </li>
                <li>
                  <Link href="/login" className="text-muted transition hover:text-fg">
                    Sign in
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-subtle">
                Company
              </p>
              <ul className="mt-3 space-y-2">
                <li>
                  <a
                    href={`https://${DOMAIN}`}
                    className="text-muted transition hover:text-fg"
                  >
                    {DOMAIN}
                  </a>
                </li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-line-soft pt-6 text-sm text-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {COMPANY}. All rights reserved.
          </p>
          <p>{DOMAIN}</p>
        </div>
      </div>
    </footer>
  );
}
