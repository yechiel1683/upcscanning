import type { Metadata } from 'next';

import { Badge, Card, CardHeader, formatDate } from '@/components/ui';
import { formatPrice } from '@/lib/packs';
import { currentUser } from '@/server/auth/session';
import { stripeConfigured } from '@/server/billing/stripe';
import { prisma } from '@/server/db';
import { BuyCredits } from './buy';

export const metadata: Metadata = { title: 'Credits' };
export const dynamic = 'force-dynamic';

/**
 * Buying credits, and the record of what was bought.
 *
 * Purchases and grants are shown separately because they answer different
 * questions. "What did I pay in March" is a receipt question; "why does my
 * balance say 340" is a ledger question, and a refunded image shows up in the
 * second with no row in the first.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ purchase?: string }>;
}) {
  const user = await currentUser();
  if (!user) return null;

  const { purchase } = await searchParams;

  const [purchases, grants] = await Promise.all([
    prisma.purchase.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    prisma.creditLedger.findMany({
      where: { userId: user.id, delta: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);

  return (
    <div className="space-y-6">
      {/*
        Stripe redirects back here after checkout, but the credits arrive by
        webhook — a different request that may land a second later or a second
        earlier. Saying "on their way" rather than "added" keeps the message
        true in both orderings.
      */}
      {purchase === 'success' ? (
        <Card className="border-positive/40 bg-positive-soft">
          <p className="p-4 text-sm text-fg">
            Payment received. Your credits are on their way and usually appear within a few
            seconds — refresh if the balance below still looks unchanged.
          </p>
        </Card>
      ) : null}
      {purchase === 'cancelled' ? (
        <Card>
          <p className="p-4 text-sm text-muted">
            Checkout was cancelled. Nothing was charged.
          </p>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="Credits"
          description="One credit is one product image that came back. They do not expire."
        />
        <div className="p-5 pt-0">
          <BuyCredits credits={user.credits} available={stripeConfigured()} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Purchases" description="Every payment, and what it bought." />
        {purchases.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted">Nothing bought yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-y border-line text-left text-xs uppercase tracking-wide text-subtle">
                  <th className="px-5 py-2.5 font-medium">Date</th>
                  <th className="px-5 py-2.5 font-medium">Pack</th>
                  <th className="px-5 py-2.5 font-medium">Images</th>
                  <th className="px-5 py-2.5 font-medium">Paid</th>
                  <th className="px-5 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {purchases.map((row) => (
                  <tr key={row.id} className="border-b border-line-soft last:border-0">
                    <td className="px-5 py-3 text-muted">{formatDate(row.createdAt)}</td>
                    <td className="px-5 py-3 text-fg">{row.packId}</td>
                    <td className="px-5 py-3 tabular-nums text-fg">
                      {row.credits.toLocaleString()}
                    </td>
                    <td className="px-5 py-3 tabular-nums text-fg">
                      {formatPrice(row.amount, row.currency)}
                    </td>
                    <td className="px-5 py-3">
                      <Badge
                        tone={
                          row.status === 'PAID'
                            ? 'positive'
                            : row.status === 'REFUNDED'
                              ? 'warning'
                              : row.status === 'FAILED'
                                ? 'danger'
                                : 'neutral'
                        }
                      >
                        {row.status === 'PENDING' ? 'Not completed' : row.status.toLowerCase()}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Credits added"
          description="Purchases, signup credit, and images returned when a picture was rejected."
        />
        {grants.length === 0 ? (
          <p className="px-5 pb-5 text-sm text-muted">Nothing yet.</p>
        ) : (
          <dl className="divide-y divide-line-soft border-t border-line text-sm">
            {grants.map((entry) => (
              <div key={entry.id} className="flex items-baseline justify-between gap-3 px-5 py-2.5">
                <dt className="text-muted">
                  {describeReason(entry.reason)}
                  {entry.note ? <span className="text-subtle"> · {entry.note}</span> : null}
                </dt>
                <dd className="flex shrink-0 items-baseline gap-3">
                  <span className="font-medium tabular-nums text-positive">+{entry.delta}</span>
                  <span className="text-xs text-subtle">{formatDate(entry.createdAt)}</span>
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
    </div>
  );
}

/** Enum names are for the database; these are for the person reading the page. */
function describeReason(reason: string): string {
  switch (reason) {
    case 'PACK_PURCHASE':
      return 'Credit pack';
    case 'SIGNUP_GRANT':
      return 'Free credits on signup';
    case 'REFUND_FAILED':
      return 'Returned — image rejected';
    case 'PURCHASE_REFUNDED':
      return 'Purchase refunded';
    case 'MANUAL_ADJUSTMENT':
      return 'Adjustment';
    case 'PLAN_RENEWAL':
      return 'Plan renewal';
    default:
      return reason;
  }
}
