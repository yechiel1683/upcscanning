import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Wordmark } from '@/components/brand';
import { SiteFooter } from '@/components/footer';
import { ThemeToggle } from '@/components/theme';
import { LinkButton } from '@/components/ui';
import { currentUser } from '@/server/auth/session';

const STEPS = [
  {
    step: '01',
    title: 'Give us your list',
    body: 'Upload the CSV or Excel file your supplier sent, or just paste a column of barcodes. Columns are detected automatically — UPC, SKU, name, brand, model — and you confirm before anything runs.',
  },
  {
    step: '02',
    title: 'We work out what each item is',
    body: 'Every barcode is resolved against product databases first, because "036000291452" is an unsearchable query and "Duracell Coppertop AA 8 Pack" is a very good one.',
  },
  {
    step: '03',
    title: 'We find the real photograph',
    body: 'Manufacturer sites, retailer listings, and image search. Every candidate is scored twice: is this the right product, and is this a usable photo. Only images that pass both are used.',
  },
  {
    step: '04',
    title: 'Download the finished catalog',
    body: 'One ZIP: every image the same size on the same background, named Brand_Product_SKU.jpg, plus a CSV with the product details we found and a list of anything that failed.',
  },
];

const AUDIENCE = [
  'Wholesalers', 'Distributors', 'Amazon sellers', 'Shopify stores',
  'Deal sites', 'Retail chains', 'Suppliers', 'Marketing agencies',
];

export default async function LandingPage() {
  const user = await currentUser();
  if (user) redirect('/dashboard');

  return (
    <div className="flex min-h-full flex-col bg-canvas">
      <header className="sticky top-0 z-30 border-b border-line/60 bg-canvas/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <Wordmark />
          <nav className="flex items-center gap-1.5">
            <ThemeToggle />
            <Link
              href="/login"
              className="rounded-lg px-3 py-2 text-sm font-medium text-muted transition hover:bg-surface-2 hover:text-fg"
            >
              Sign in
            </Link>
            <LinkButton href="/register" size="sm">
              Start free
            </LinkButton>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* Hero */}
        <section className="hero-glow relative overflow-hidden">
          <div className="grid-lines pointer-events-none absolute inset-0" aria-hidden />
          <div className="relative mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
            <div className="grid items-center gap-12 lg:grid-cols-[1.18fr_1fr]">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-medium text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  Bulk product imagery, automated
                </span>

                <h1 className="mt-6 text-[2.5rem] font-semibold leading-[1.06] tracking-[-0.025em] text-fg sm:text-[3.35rem]">
                  <span className="block">Barcodes in.</span>
                  <span className="block text-accent lg:whitespace-nowrap">Product images out.</span>
                </h1>

                <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                  Upload the price list you were sent — or paste nothing but UPCs. Get back
                  professional, consistent ecommerce photography for every item, with the
                  product details filled in, packaged as a ZIP you can send to a customer
                  the same afternoon.
                </p>

                <div className="mt-9 flex flex-wrap items-center gap-3">
                  <LinkButton href="/register" size="lg">
                    Start with 50 free images
                  </LinkButton>
                  <LinkButton href="/login" variant="secondary" size="lg">
                    Sign in
                  </LinkButton>
                </div>

                <p className="mt-4 text-sm text-subtle">No card required.</p>
              </div>

              <BeforeAfter />
            </div>
          </div>
        </section>

        {/* The problem */}
        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="grid gap-12 lg:grid-cols-[1fr_1.2fr]">
              <div>
                <h2 className="text-3xl font-semibold tracking-tight text-fg">
                  The list arrives.
                  <br />
                  The images do not.
                </h2>
                <p className="mt-5 leading-relaxed text-muted">
                  Suppliers send SKUs, barcodes, and descriptions. Then somebody spends two
                  days searching for each product, saving photos, cutting out backgrounds,
                  and renaming files — for a catalog that has to go out tomorrow.
                </p>
              </div>

              <dl className="grid gap-4 sm:grid-cols-2">
                {[
                  ['Hunting for each photo', 'The manufacturer site, then Amazon, then Google. One SKU at a time.'],
                  ['Inconsistent results', 'Twelve sources, twelve backgrounds, twelve sizes. Nothing looks like a catalog.'],
                  ['Manual cutouts', 'Removing backgrounds by hand, or paying per image to have it done.'],
                  ['Renaming everything', 'Files called download(4).jpg that nobody can match back to a SKU.'],
                ].map(([title, body]) => (
                  <div
                    key={title}
                    className="rounded-xl border border-line bg-surface p-5 transition hover:border-accent-line"
                  >
                    <dt className="text-sm font-semibold text-fg">{title}</dt>
                    <dd className="mt-1.5 text-sm leading-relaxed text-muted">{body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-line bg-surface-2/70">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="text-3xl font-semibold tracking-tight text-fg">How it works</h2>
            <p className="mt-3 max-w-2xl text-muted">
              One upload, four automated stages, one download. Ten products or ten thousand —
              the work is the same for you.
            </p>

            <ol className="mt-12 grid gap-5 md:grid-cols-2">
              {STEPS.map((item) => (
                <li
                  key={item.step}
                  className="rounded-xl border border-line bg-surface p-6 transition hover:border-accent-line"
                >
                  <span className="font-mono text-xs font-semibold tracking-wider text-accent">
                    {item.step}
                  </span>
                  <h3 className="mt-3 text-base font-semibold text-fg">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{item.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Output */}
        <section className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-2 lg:items-center">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-fg">
                What lands in your downloads folder
              </h2>
              <p className="mt-5 text-muted">
                Not a folder of raw scrapes. A catalog ready to hand to a customer, upload to
                Shopify, or attach to a quote.
              </p>
              <ul className="mt-7 space-y-3 text-sm text-muted">
                {[
                  'Every image the same dimensions, on the same background',
                  'Clean cutouts with soft contact shadows, not hard scissor edges',
                  'Predictable filenames that map straight back to your SKUs',
                  'A CSV with the product details we discovered along the way',
                  'Real photos and AI-generated images clearly distinguished',
                  'An explicit list of anything that failed, with the reason',
                ].map((line) => (
                  <li key={line} className="flex gap-3">
                    <CheckIcon />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
                <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
                <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
                <span className="h-2.5 w-2.5 rounded-full bg-surface-3" />
                <span className="ml-2 font-mono text-xs text-subtle">catalog_images.zip</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-muted">
                <span className="text-subtle">Product Images/</span>
                {'\n  '}
                <span className="text-fg">Duracell_AA_8_Pack_036000291452.jpg</span>
                {'\n  '}
                <span className="text-fg">DeWalt_20V_Max_Drill_885911574518.jpg</span>
                {'\n  '}
                <span className="text-fg">Apple_AirPods_Pro_190199098701.jpg</span>
                {'\n  ...\n'}
                {'products_with_images.csv\nprocessing_report.txt\nfailed_products.csv\nREADME.txt'}
              </pre>
            </div>
          </div>
        </section>

        {/* Audience */}
        <section className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-center text-xs font-medium uppercase tracking-[0.2em] text-subtle">
              Built for teams that live in spreadsheets
            </h2>
            <ul className="mx-auto mt-7 flex max-w-3xl flex-wrap justify-center gap-2">
              {AUDIENCE.map((item) => (
                <li
                  key={item}
                  className="rounded-full border border-line bg-surface px-4 py-1.5 text-sm text-muted"
                >
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-line bg-surface-2/70">
          <div className="mx-auto max-w-3xl px-6 py-24 text-center">
            <h2 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Your next product list should not cost you two days.
            </h2>
            <p className="mt-4 text-lg text-muted">
              Upload it, get a coffee, download the catalog.
            </p>
            <div className="mt-9 flex justify-center">
              <LinkButton href="/register" size="lg">
                Start with 50 free images
              </LinkButton>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

function CheckIcon() {
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent-soft">
      <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3 text-accent">
        <path
          d="m3.5 8.5 3 3 6-7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

/** A static illustration of the transformation, rendered entirely in markup. */
function BeforeAfter() {
  const rows = [
    ['036000291452', 'Duracell'],
    ['885911574518', 'DeWalt'],
    ['5449000000996', 'Coca_Cola'],
    ['190199098701', 'Apple'],
  ];

  return (
    <div className="grid gap-5 sm:grid-cols-[1fr_auto_1.15fr] sm:items-center">
      <div className="rounded-xl border border-line bg-surface p-4 shadow-raised">
        <p className="px-1 pb-2.5 font-mono text-[11px] text-subtle">barcodes.txt</p>
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-left text-subtle">
              <th className="border-b border-line-soft px-1.5 py-1 font-medium">UPC</th>
              <th className="border-b border-line-soft px-1.5 py-1 font-medium">Product</th>
            </tr>
          </thead>
          <tbody className="font-mono text-muted">
            {rows.map((row) => (
              <tr key={row[0]}>
                <td className="border-b border-line-soft px-1.5 py-2">{row[0]}</td>
                <td className="border-b border-line-soft px-1.5 py-2 text-subtle">—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-center text-subtle sm:flex-col">
        <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 rotate-90 sm:rotate-0">
          <path
            d="M4 12h16m0 0-6-6m6 6-6 6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {rows.map((row, index) => (
          <figure
            key={row[0]}
            className="overflow-hidden rounded-xl border border-line bg-surface shadow-raised"
          >
            {/* Product photos sit on white in both themes — that is the product
                itself, not page chrome. */}
            <div className="flex aspect-square items-center justify-center bg-white p-5">
              <ProductGlyph index={index} />
            </div>
            <figcaption className="truncate border-t border-line-soft px-2.5 py-2 font-mono text-[10px] text-muted">
              {row[1]}_….jpg
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

/** Simple vector stand-ins for product photography in the hero. */
function ProductGlyph({ index }: { index: number }) {
  const glyphs = [
    <g key="batteries">
      <rect x="18" y="16" width="11" height="32" rx="2" fill="#C8791E" />
      <rect x="18" y="16" width="11" height="9" fill="#2B2B2E" />
      <rect x="21.5" y="12.5" width="4" height="4" rx="1" fill="#9A9AA0" />
      <rect x="33" y="16" width="11" height="32" rx="2" fill="#C8791E" />
      <rect x="33" y="16" width="11" height="9" fill="#2B2B2E" />
      <rect x="36.5" y="12.5" width="4" height="4" rx="1" fill="#9A9AA0" />
    </g>,
    <g key="drill">
      <rect x="12" y="21" width="28" height="14" rx="7" fill="#F5C518" />
      <rect x="38" y="24" width="14" height="8" rx="1.5" fill="#3B4252" />
      <path d="M18 35h10l-2 14h-6z" fill="#F5C518" />
      <rect x="14" y="47" width="16" height="8" rx="2.5" fill="#2B3040" />
    </g>,
    <g key="can">
      <rect x="23" y="12" width="18" height="40" rx="4" fill="#D6303A" />
      <rect x="23" y="12" width="18" height="5" rx="2" fill="#B8B8BE" />
      <rect x="26" y="26" width="12" height="3" rx="1.5" fill="#ffffff" opacity="0.85" />
      <rect x="26" y="32" width="8" height="2.4" rx="1.2" fill="#ffffff" opacity="0.6" />
    </g>,
    <g key="airpods">
      <rect
        x="19"
        y="22"
        width="26"
        height="22"
        rx="7"
        fill="#F2F3F5"
        stroke="#C9CDD6"
        strokeWidth="1.2"
      />
      <path d="M19 31h26" stroke="#C9CDD6" strokeWidth="1.2" />
      <circle cx="32" cy="48" r="1.8" fill="#C9CDD6" />
    </g>,
  ];

  return (
    <svg
      viewBox="0 0 64 64"
      className="h-full w-full"
      role="img"
      aria-label="Product photo placeholder"
    >
      {glyphs[index % glyphs.length]}
      <ellipse cx="32" cy="57" rx="17" ry="2.2" fill="#0F172A" opacity="0.12" />
    </svg>
  );
}
