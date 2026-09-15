import { LedgerReason, PurchaseStatus } from '@prisma/client';

import { prisma } from '@/server/db';

/**
 * Turning a payment into credits, exactly once.
 *
 * Stripe retries a webhook until it receives a 2xx. A slow response, a deploy
 * mid-request, a transient 500 — each means the same `checkout.session.completed`
 * event arrives again, sometimes several times. Crediting on each delivery
 * hands a customer two or three packs for one payment, and nothing about that
 * shows up as an error anywhere.
 *
 * The defence is a unique constraint on `stripeSessionId`, not a check-then-act
 * in application code. Two deliveries arriving concurrently both read "not yet
 * credited" and both proceed; only the database can settle it, and it does so
 * by refusing the second insert. So the insert is attempted, and a uniqueness
 * violation is treated as success — because it means the work was already done.
 */

/** Postgres, via Prisma, for a duplicate key. */
const UNIQUE_VIOLATION = 'P2002';

export interface CreditOutcome {
  credited: boolean;
  /** Set when the purchase already existed, so the caller can log it plainly. */
  reason?: 'already-processed';
  purchaseId?: string;
}

export interface PaidSession {
  stripeSessionId: string;
  stripePaymentIntentId?: string | null;
  userId: string;
  packId: string;
  credits: number;
  /** Cents, as Stripe reported them — not as we hoped they would be. */
  amount: number;
  currency: string;
}

/**
 * Record a completed payment and grant its credits.
 *
 * The purchase row, the ledger entry and the balance move together or not at
 * all. A balance raised without a ledger entry is unauditable, and a ledger
 * entry without a balance is a customer who paid and got nothing.
 */
export async function creditPurchase(session: PaidSession): Promise<CreditOutcome> {
  try {
    const purchase = await prisma.$transaction(async (tx) => {
      // The uniqueness of stripeSessionId does the real work. If this throws,
      // a previous delivery already credited this payment.
      const created = await tx.purchase.create({
        data: {
          userId: session.userId,
          status: PurchaseStatus.PAID,
          packId: session.packId,
          credits: session.credits,
          amount: session.amount,
          currency: session.currency,
          stripeSessionId: session.stripeSessionId,
          stripePaymentIntentId: session.stripePaymentIntentId ?? null,
          paidAt: new Date(),
        },
      });

      await tx.creditLedger.create({
        data: {
          userId: session.userId,
          delta: session.credits,
          reason: LedgerReason.PACK_PURCHASE,
          purchaseId: created.id,
          note: session.packId,
        },
      });

      await tx.user.update({
        where: { id: session.userId },
        data: { credits: { increment: session.credits } },
      });

      return created;
    });

    return { credited: true, purchaseId: purchase.id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Not a failure. Stripe delivered the same event twice, which it is
      // supposed to do, and the second delivery has nothing left to do.
      return { credited: false, reason: 'already-processed' };
    }
    throw error;
  }
}

/**
 * Take the credits back when a payment is refunded.
 *
 * Allowed to drive a balance negative, and that is deliberate: the alternative
 * is clamping at zero, which lets someone buy a pack, spend it, refund the
 * payment, and keep the images. A negative balance blocks new work until it is
 * settled, which is the correct outcome and visible to support.
 */
export async function refundPurchase(stripeSessionId: string): Promise<CreditOutcome> {
  const purchase = await prisma.purchase.findUnique({ where: { stripeSessionId } });

  // A refund for something never recorded, or refunded already. Both are
  // no-ops rather than errors — the webhook must still return 2xx or Stripe
  // will keep redelivering forever.
  if (!purchase || purchase.status !== PurchaseStatus.PAID) {
    return { credited: false, reason: 'already-processed' };
  }

  await prisma.$transaction(async (tx) => {
    await tx.purchase.update({
      where: { id: purchase.id },
      data: { status: PurchaseStatus.REFUNDED, refundedAt: new Date() },
    });

    await tx.creditLedger.create({
      data: {
        userId: purchase.userId,
        delta: -purchase.credits,
        reason: LedgerReason.PURCHASE_REFUNDED,
        purchaseId: purchase.id,
        note: purchase.packId,
      },
    });

    await tx.user.update({
      where: { id: purchase.userId },
      data: { credits: { decrement: purchase.credits } },
    });
  });

  return { credited: true, purchaseId: purchase.id };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}
