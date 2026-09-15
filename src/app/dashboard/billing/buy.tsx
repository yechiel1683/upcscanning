'use client';

import { useState } from 'react';

import { PACKS, centsPerImage, formatPrice } from '@/lib/packs';
import { Badge, Button, Card, cn } from '@/components/ui';

/**
 * Choosing and buying a pack.
 *
 * The middle pack is marked as the usual choice rather than left to the
 * customer to work out. Three prices with no guidance is a decision people
 * postpone, and a postponed purchase is a lost one.
 */
export function BuyCredits({ credits, available }: { credits: number; available: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(packId: string) {
    setBusy(packId);
    setError(null);
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packId }),
      });
      const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };

      if (!response.ok || !body.url) {
        setError(body.error ?? 'We could not start the checkout. Please try again.');
        return;
      }
      // Stripe's hosted page. We never see a card number.
      window.location.href = body.url;
    } catch {
      setError('The request did not reach the server. Check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-muted">
          You have{' '}
          <span className="font-semibold tabular-nums text-fg">{credits.toLocaleString()}</span>{' '}
          image{credits === 1 ? '' : 's'} left.
        </p>
        {credits <= 25 ? (
          <Badge tone={credits === 0 ? 'danger' : 'warning'}>
            {credits === 0 ? 'Out of credits' : 'Running low'}
          </Badge>
        ) : null}
      </div>

      {!available ? (
        <Card className="border-warning/40 bg-warning-soft">
          <p className="p-4 text-sm text-fg">
            Payments are not switched on for this instance yet, so packs cannot be bought here.
          </p>
        </Card>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-3">
        {PACKS.map((pack, index) => {
          const usual = index === 1;
          return (
            <Card
              key={pack.id}
              className={cn('flex flex-col', usual && 'border-accent-line bg-accent-soft')}
            >
              <div className="flex-1 space-y-2 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-fg">{pack.name}</p>
                  {usual ? <Badge tone="accent">Most chosen</Badge> : null}
                </div>

                <p className="text-2xl font-semibold tabular-nums text-fg">
                  {formatPrice(pack.amount, pack.currency)}
                </p>

                <p className="text-sm text-muted">
                  {pack.credits.toLocaleString()} product images
                </p>
                <p className="text-[11px] text-subtle">
                  {(centsPerImage(pack) / 100).toFixed(3).replace(/0+$/, '')} per image
                </p>

                <p className="pt-1 text-[13px] leading-snug text-muted">{pack.blurb}</p>
              </div>

              <div className="border-t border-line-soft p-3">
                <Button
                  className="w-full"
                  variant={usual ? 'primary' : 'secondary'}
                  disabled={!available || busy !== null}
                  onClick={() => void buy(pack.id)}
                >
                  {busy === pack.id ? 'Opening checkout…' : 'Buy'}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>

      <p className="text-[13px] leading-relaxed text-muted">
        Credits never expire, and you are only charged for images that actually come back — a row
        that finds nothing costs nothing, and rejecting a picture on review returns its credit.
      </p>
    </div>
  );
}
