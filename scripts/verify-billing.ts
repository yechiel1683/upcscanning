import 'dotenv/config';

import { PurchaseStatus } from '@prisma/client';

import { prisma } from '@/server/db';
import { creditPurchase, refundPurchase } from '@/server/billing/credit';

/**
 * Exercise the money path against a real PostgreSQL.
 *
 * The property that matters most here is not expressible in a unit test: a
 * redelivered webhook must never credit twice, and the thing preventing it is
 * a unique constraint in the database. A mocked Prisma client has no unique
 * constraints, so a test against one passes whether the protection exists or
 * not — which is the worst kind of test to have guarding revenue.
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-billing.ts
 *
 * Writes and removes its own rows. Point it at a scratch database.
 */

let failures = 0;

function check(name: string, passed: boolean, detail = '') {
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

async function main() {
  const email = `billing-check-${Date.now()}@example.test`;
  const user = await prisma.user.create({
    data: { email, passwordHash: 'x', credits: 0 },
  });

  const session = {
    stripeSessionId: `cs_test_${Date.now()}`,
    stripePaymentIntentId: `pi_test_${Date.now()}`,
    userId: user.id,
    packId: 'standard-1000',
    credits: 1000,
    amount: 9900,
    currency: 'usd',
  };

  try {
    console.log('\nCrediting a completed payment');
    const first = await creditPurchase(session);
    check('reports it credited', first.credited === true);

    const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('balance went up by the pack size', afterFirst.credits === 1000, `${afterFirst.credits}`);

    const ledger = await prisma.creditLedger.findMany({ where: { userId: user.id } });
    check('wrote exactly one ledger entry', ledger.length === 1, `${ledger.length}`);
    check('ledger entry matches the balance change', ledger[0]?.delta === 1000);
    check('ledger entry points at the purchase', Boolean(ledger[0]?.purchaseId));

    console.log('\nThe same webhook delivered again (Stripe retries until it gets a 2xx)');
    const second = await creditPurchase(session);
    check('reports it did not credit', second.credited === false);
    check('says why', second.reason === 'already-processed');

    const afterSecond = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check(
      'balance did NOT move — this is the bug that gives away a free pack',
      afterSecond.credits === 1000,
      `${afterSecond.credits}`,
    );

    const ledgerAfter = await prisma.creditLedger.findMany({ where: { userId: user.id } });
    check('still exactly one ledger entry', ledgerAfter.length === 1, `${ledgerAfter.length}`);

    console.log('\nFive deliveries arriving at once');
    // The realistic shape of the race: a slow response makes Stripe retry
    // while the first attempt is still in flight. Check-then-act loses here;
    // only the database constraint settles it.
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => creditPurchase(session)),
    );
    check(
      'none of them credited again',
      concurrent.every((outcome) => outcome.credited === false),
    );
    const afterRace = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('balance still 1000 after the race', afterRace.credits === 1000, `${afterRace.credits}`);

    console.log('\nA concurrent first delivery of a fresh payment');
    const fresh = { ...session, stripeSessionId: `cs_test_race_${Date.now()}`, stripePaymentIntentId: `pi_race_${Date.now()}` };
    const firstRace = await Promise.all(Array.from({ length: 5 }, () => creditPurchase(fresh)));
    check(
      'exactly one of five credited',
      firstRace.filter((outcome) => outcome.credited).length === 1,
      `${firstRace.filter((o) => o.credited).length}`,
    );
    const afterFreshRace = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('balance went up once, not five times', afterFreshRace.credits === 2000, `${afterFreshRace.credits}`);

    console.log('\nRefunding');
    const refunded = await refundPurchase(session.stripeSessionId);
    check('reports it refunded', refunded.credited === true);

    const afterRefund = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('credits were taken back', afterRefund.credits === 1000, `${afterRefund.credits}`);

    const purchase = await prisma.purchase.findUniqueOrThrow({
      where: { stripeSessionId: session.stripeSessionId },
    });
    check('purchase is marked refunded', purchase.status === PurchaseStatus.REFUNDED);
    check('refund is timestamped', purchase.refundedAt !== null);

    console.log('\nRefunding the same payment twice');
    const again = await refundPurchase(session.stripeSessionId);
    check('second refund is a no-op', again.credited === false);
    const afterDouble = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    check('credits were not taken twice', afterDouble.credits === 1000, `${afterDouble.credits}`);

    console.log('\nRefunding a payment nobody has on record');
    const unknown = await refundPurchase('cs_test_never_seen');
    check('is a no-op rather than a crash', unknown.credited === false);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? '\nAll billing checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
