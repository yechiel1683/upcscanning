import Link from 'next/link';
import { redirect } from 'next/navigation';

import { LinkButton } from '@/components/ui';
import { currentUser } from '@/server/auth/session';

const STEPS = [
  {
    step: '01',
    title: 'Upload your product list',
    body: 'Drop in the CSV or Excel file your supplier sent. Columns are detected automatically — UPC, SKU, product name, brand, model, description. Correct anything we got wrong before you commit.',
  },
  {
    step: '02',
    title: 'We find the real product photo',
    body: 'Every row is identified, then matched against barcode databases, manufacturer catalogs, and retailer listings. Each candidate is scored for whether it is the right product and whether it is a usable photo.',
  },
  {
    step: '03',
    title: 'Anything we cannot find, we generate',
    body: 'Products with no photograph anywhere get a studio-quality render built from their own description — and they are labelled as AI-generated so you always know what you are shipping.',
  },
  {
    step: '04',
    title: 'Download the finished catalog',
    body: 'One ZIP: every image at the same size on the same background, named Brand_Product_SKU.jpg, plus an updated CSV, a processing report, and a list of anything that failed.',
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
    <div className="min-h-full bg-white">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-base font-semibold tracking-tight text-ink-900">CatalogForge</span>
        </div>
        <nav className="flex items-center gap-2">
          <Link
            href="/login"
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-600 transition hover:bg-ink-100 hover:text-ink-900"
          >
            Sign in
          </Link>
          <LinkButton href="/register" size="sm">
            Start free
          </LinkButton>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-6 pt-12 pb-20 sm:pt-20">
          <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full bg-accent-50 px-3 py-1 text-xs font-medium text-accent-700 ring-1 ring-inset ring-accent-100">
                Bulk product imagery, automated
              </span>
              <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight text-ink-950 sm:text-5xl">
                Turn a supplier spreadsheet into a finished product image catalog.
              </h1>
              <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-600">
                Upload the price list you were sent. Get back professional, consistent
                ecommerce photography for every item in it — sourced where a real photo
                exists, generated where one does not, and packaged as a ZIP you can send
                to a customer the same afternoon.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <LinkButton href="/register">Upload your first list</LinkButton>
                <LinkButton href="/login" variant="secondary">
                  Sign in
                </LinkButton>
              </div>
              <p className="mt-4 text-sm text-ink-500">
                50 free images to start. No card required.
              </p>
            </div>

            <BeforeAfter />
          </div>
        </section>

        {/* The problem */}
        <section className="border-y border-ink-200 bg-ink-50">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight text-ink-950">
                  The list arrives. The images do not.
                </h2>
                <p className="mt-4 text-ink-600">
                  Suppliers send you SKUs, barcodes, and descriptions. Then somebody on your
                  team spends two days searching for each product, saving photos, cutting out
                  backgrounds, and renaming files — for a catalog that has to go out tomorrow.
                </p>
              </div>
              <dl className="grid gap-4 sm:grid-cols-2">
                {[
                  ['Hunting for each photo', 'Searching the manufacturer site, then Amazon, then Google, one SKU at a time.'],
                  ['Inconsistent results', 'Twelve sources, twelve backgrounds, twelve sizes. Nothing looks like a catalog.'],
                  ['Manual cutouts', 'Removing backgrounds by hand, or paying per image to have it done.'],
                  ['Renaming everything', 'Files called download(4).jpg that nobody can match back to a SKU.'],
                ].map(([title, body]) => (
                  <div key={title} className="rounded-xl border border-ink-200 bg-white p-4">
                    <dt className="text-sm font-semibold text-ink-900">{title}</dt>
                    <dd className="mt-1 text-sm leading-relaxed text-ink-500">{body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-2xl font-semibold tracking-tight text-ink-950">How it works</h2>
          <p className="mt-2 max-w-2xl text-ink-600">
            One upload, four automated stages, one download. Ten products or ten thousand —
            the work is the same for you.
          </p>

          <ol className="mt-10 grid gap-6 md:grid-cols-2">
            {STEPS.map((item) => (
              <li key={item.step} className="rounded-xl border border-ink-200 bg-white p-6">
                <span className="font-mono text-xs font-semibold text-accent-600">{item.step}</span>
                <h3 className="mt-2 text-base font-semibold text-ink-900">{item.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-600">{item.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Output detail */}
        <section className="border-t border-ink-200 bg-ink-950 text-white">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 lg:grid-cols-2">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                What lands in your downloads folder
              </h2>
              <p className="mt-4 text-ink-400">
                Not a folder of raw scrapes. A catalog that is ready to hand to a customer,
                upload to Shopify, or attach to a quote.
              </p>
              <ul className="mt-6 space-y-3 text-sm text-ink-200">
                {[
                  'Every image the same dimensions, on the same background',
                  'Clean cutouts with soft contact shadows, not hard scissor edges',
                  'Predictable filenames that map straight back to your SKUs',
                  'A CSV of your original rows with the image filename attached',
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

            <div className="rounded-xl border border-white/10 bg-white/[0.04] p-6">
              <p className="text-xs font-medium uppercase tracking-wider text-ink-400">
                catalog_images.zip
              </p>
              <pre className="mt-4 overflow-x-auto font-mono text-[13px] leading-relaxed text-ink-200">
{`Product Images/
  Samsung_55_Inch_Smart_TV_12345.jpg
  Apple_AirPods_Pro_2_67890.jpg
  DeWalt_20V_Max_Drill_54321.jpg
  ...
products_with_images.csv
processing_report.txt
failed_products.csv
README.txt`}
              </pre>
            </div>
          </div>
        </section>

        {/* Audience */}
        <section className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-center text-sm font-medium uppercase tracking-wider text-ink-500">
            Built for teams that live in spreadsheets
          </h2>
          <ul className="mx-auto mt-6 flex max-w-3xl flex-wrap justify-center gap-2">
            {AUDIENCE.map((item) => (
              <li
                key={item}
                className="rounded-full border border-ink-200 bg-white px-3.5 py-1.5 text-sm text-ink-600"
              >
                {item}
              </li>
            ))}
          </ul>
        </section>

        {/* CTA */}
        <section className="border-t border-ink-200 bg-ink-50">
          <div className="mx-auto max-w-3xl px-6 py-20 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-ink-950">
              Your next product list does not have to cost you two days.
            </h2>
            <p className="mt-3 text-ink-600">
              Upload it, get a coffee, download the catalog.
            </p>
            <div className="mt-8 flex justify-center">
              <LinkButton href="/register">Start with 50 free images</LinkButton>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-ink-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-6 py-8 text-sm text-ink-500 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Logo />
            <span>CatalogForge</span>
          </div>
          <p>Spreadsheet in, product catalog out.</p>
        </div>
      </footer>
    </div>
  );
}

function Logo() {
  return (
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
        <path d="M3.5 13.5 7 10l3 3 3-2.5 3.5 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="7.75" cy="7.25" r="1.25" fill="currentColor" />
      </svg>
    </span>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="mt-0.5 h-4 w-4 shrink-0 text-accent-500">
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A static illustration of the transformation, rendered entirely in markup. */
function BeforeAfter() {
  const rows = [
    ['012345678901', 'Samsung 55" Smart TV', 'Samsung'],
    ['088381098717', 'Makita Impact Driver', 'Makita'],
    ['190199098702', 'Apple AirPods Pro 2', 'Apple'],
    ['885911574518', 'DeWalt 20V Drill', 'DeWalt'],
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
      <div className="rounded-xl border border-ink-200 bg-white p-3 shadow-sm">
        <p className="px-1 pb-2 text-xs font-medium text-ink-500">supplier_list.xlsx</p>
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="text-left text-ink-400">
              <th className="border-b border-ink-200 px-1.5 py-1 font-medium">UPC</th>
              <th className="border-b border-ink-200 px-1.5 py-1 font-medium">Product</th>
            </tr>
          </thead>
          <tbody className="font-mono text-ink-600">
            {rows.map((row) => (
              <tr key={row[0]}>
                <td className="border-b border-ink-100 px-1.5 py-1.5">{row[0]}</td>
                <td className="truncate border-b border-ink-100 px-1.5 py-1.5">{row[1]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-center text-ink-400 sm:flex-col">
        <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6 rotate-90 sm:rotate-0">
          <path d="M4 12h16m0 0-6-6m6 6-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {rows.map((row, index) => (
          <figure
            key={row[0]}
            className="overflow-hidden rounded-xl border border-ink-200 bg-white shadow-sm"
          >
            <div className="flex aspect-square items-center justify-center bg-white p-4">
              <ProductGlyph index={index} />
            </div>
            <figcaption className="truncate border-t border-ink-100 px-2 py-1.5 font-mono text-[10px] text-ink-500">
              {row[2]}_...jpg
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
    // TV
    <g key="tv">
      <rect x="6" y="14" width="52" height="30" rx="2.5" fill="#1f2430" />
      <rect x="8.5" y="16.5" width="47" height="25" rx="1.5" fill="#39415a" />
      <rect x="27" y="46" width="10" height="6" fill="#2b3040" />
      <rect x="19" y="52" width="26" height="3" rx="1.5" fill="#1f2430" />
    </g>,
    // Impact driver
    <g key="driver">
      <rect x="14" y="20" width="30" height="13" rx="6.5" fill="#1d9ad6" />
      <rect x="40" y="23" width="12" height="7" rx="2" fill="#3b4252" />
      <path d="M20 33h11l-2.5 17H22z" fill="#1d9ad6" />
      <rect x="17.5" y="48" width="16" height="7" rx="2" fill="#2b3040" />
    </g>,
    // Earbuds case
    <g key="airpods">
      <rect x="19" y="22" width="26" height="22" rx="7" fill="#f2f3f5" stroke="#c9cdd6" strokeWidth="1.2" />
      <path d="M19 31h26" stroke="#c9cdd6" strokeWidth="1.2" />
      <circle cx="32" cy="48" r="1.8" fill="#c9cdd6" />
    </g>,
    // Drill
    <g key="drill">
      <rect x="12" y="21" width="28" height="14" rx="7" fill="#f5c518" />
      <rect x="38" y="24" width="14" height="8" rx="1.5" fill="#3b4252" />
      <path d="M18 35h10l-2 14h-6z" fill="#f5c518" />
      <rect x="14" y="47" width="16" height="8" rx="2.5" fill="#2b3040" />
    </g>,
  ];

  return (
    <svg viewBox="0 0 64 64" className="h-full w-full" role="img" aria-label="Product photo placeholder">
      {glyphs[index % glyphs.length]}
      <ellipse cx="32" cy="58" rx="18" ry="2.4" fill="#0f172a" opacity="0.1" />
    </svg>
  );
}
