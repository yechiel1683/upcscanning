import { ok, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What this account has bought, and where its credits went.
 *
 * Both halves matter and neither answers the other. "I bought 1,000 images,
 * where are they" is a question about the ledger; "what did I pay in March" is
 * a question about purchases. Showing only one of them turns the other into a
 * support email.
 */
export const GET = withUser(async (user) => {
  const [purchases, ledger] = await Promise.all([
    prisma.purchase.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, status: true, packId: true, credits: true,
        amount: true, currency: true, createdAt: true, paidAt: true, refundedAt: true,
      },
    }),
    // Grants and refunds only. Per-image consumption is thousands of rows and
    // belongs on the batch page, where it has context.
    prisma.creditLedger.findMany({
      where: { userId: user.id, delta: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, delta: true, reason: true, note: true, createdAt: true },
    }),
  ]);

  return ok({ credits: user.credits, purchases, grants: ledger });
});
