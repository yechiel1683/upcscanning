import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge, Card, buttonClass, cn } from '@/components/ui';
import { PACKS, centsPerImage, formatPrice } from '@/lib/packs';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Credit packs for UPC Scanning. One credit is one product image. Credits never expire and a row that finds nothing costs nothing.',
};

/**
 * What it costs, stated plainly.
 *
 * No subscription, because a distributor's work is lumpy — four hundred
 * products one week and nothing the next — and the honest version of that is
 * packs that sit there until they are needed.
 */
export default function PricingPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-12 sm:py-16">
      <header className="mx-auto max-w-2xl text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
          Pay for the pictures you get
        </h1>
        <p className="mt-3 text-base leading-relaxed text-muted">
          One credit is one product image. No subscription, no minimum, and nothing expires — a
          catalog you refresh twice a year should not cost you twelve months of fees.
        </p>
      </header>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {PACKS.map((pack, index) => {
          const usual = index === 1;
          return (
            <Card
              key={pack.id}
              className={cn('flex flex-col', usual && 'border-accent-line bg-accent-soft')}
            >
              <div className="flex-1 space-y-3 p-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-fg">{pack.name}</p>
                  {usual ? <Badge tone="accent">Most chosen</Badge> : null}
                </div>

                <p className="text-3xl font-semibold tabular-nums tracking-tight text-fg">
                  {formatPrice(pack.amount, pack.currency)}
                </p>

                <div>
                  <p className="text-sm text-fg">
                    {pack.credits.toLocaleString()} product images
                  </p>
                  <p className="text-xs text-subtle">
                    {(centsPerImage(pack) / 100).toFixed(3).replace(/0+$/, '')} each
                  </p>
                </div>

                <p className="text-sm leading-snug text-muted">{pack.blurb}</p>
              </div>

              <div className="border-t border-line-soft p-4">
                <Link
                  href="/register"
                  className={cn(buttonClass(usual ? 'primary' : 'secondary'), 'w-full')}
                >
                  Get started
                </Link>
              </div>
            </Card>
          );
        })}
      </div>

      <section className="mx-auto mt-12 max-w-2xl space-y-5">
        <h2 className="text-lg font-semibold text-fg">What you are actually charged for</h2>

        <div className="space-y-4 text-sm leading-relaxed text-muted">
          <p>
            <strong className="text-fg">A row that finds nothing costs nothing.</strong> Credits
            come off when an image comes back, not when you upload. A barcode with no photograph
            anywhere online is not something you should pay for.
          </p>
          <p>
            <strong className="text-fg">Rejecting a picture returns its credit.</strong> When the
            search is not confident it says so and asks you, rather than filing the result quietly.
            If you say the picture is wrong, you get the credit back.
          </p>
          <p>
            <strong className="text-fg">Try it before you pay anything.</strong> Paste your own
            barcodes on the{' '}
            <Link href="/try" className="text-accent underline underline-offset-2">
              trial page
            </Link>{' '}
            — no account, no card, and the same pipeline a paying customer gets.
          </p>
          <p>
            <strong className="text-fg">Nothing expires.</strong> Credits sit in your account until
            you use them.
          </p>
        </div>
      </section>
    </main>
  );
}
