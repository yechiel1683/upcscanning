import 'dotenv/config';

import { VerificationPurpose } from '@prisma/client';

import { prisma } from '@/server/db';
import {
  VERIFICATION_LIMITS,
  checkCode,
  issueCode,
  sweepVerificationCodes,
} from '@/server/auth/verification';

/**
 * Exercise the verification codes against a real PostgreSQL.
 *
 * Every property worth having here is enforced by a database write — an
 * attempt counter that must increment across rows, a single-use update that
 * must lose a race, an expiry compared by the database's clock. A mock has
 * none of that, so a passing unit test would say nothing about whether a code
 * can be brute-forced or replayed.
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-auth.ts
 */

let failures = 0;

function check(name: string, passed: boolean, detail = '') {
  console.log(`${passed ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures += 1;
}

const addr = () => `verify-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

async function main() {
  try {
    console.log('\nIssuing and using a code');
    const email = addr();
    const issued = await issueCode({
      email,
      purpose: VerificationPurpose.SIGNUP,
      pendingName: 'Test Person',
      pendingPasswordHash: 'hashed',
    });
    check('a code was issued', issued !== null);
    check(
      'it is six digits',
      /^\d{6}$/.test(issued!.code),
      issued!.code.replace(/\d/g, '•'),
    );

    const good = await checkCode(email, VerificationPurpose.SIGNUP, issued!.code);
    check('the right code is accepted', good.ok === true);
    check(
      'it carries the pending signup details',
      good.ok === true && good.pendingPasswordHash === 'hashed',
    );

    console.log('\nThe same code a second time');
    const replay = await checkCode(email, VerificationPurpose.SIGNUP, issued!.code);
    check('is refused — a code works exactly once', replay.ok === false);

    console.log('\nGuessing');
    const guessEmail = addr();
    const target = await issueCode({ email: guessEmail, purpose: VerificationPurpose.SIGNUP });
    const wrong = target!.code === '000000' ? '111111' : '000000';

    const verdicts = [];
    for (let i = 0; i < VERIFICATION_LIMITS.MAX_ATTEMPTS + 1; i += 1) {
      verdicts.push(await checkCode(guessEmail, VerificationPurpose.SIGNUP, wrong));
    }
    check(
      'runs out of attempts rather than guesses',
      verdicts[verdicts.length - 1]!.ok === false &&
        (verdicts[verdicts.length - 1] as { reason: string }).reason === 'too-many-attempts',
    );

    const afterBurn = await checkCode(guessEmail, VerificationPurpose.SIGNUP, target!.code);
    check(
      'the RIGHT code no longer works once attempts are spent',
      afterBurn.ok === false,
      'a burnt code must stay burnt',
    );

    console.log('\nAsking for more codes does not buy more guesses');
    // The attack: request three codes, and get five attempts against each.
    const multiEmail = addr();
    const codes = [];
    for (let i = 0; i < 3; i += 1) {
      codes.push(await issueCode({ email: multiEmail, purpose: VerificationPurpose.SIGNUP }));
    }
    check('three codes were issued', codes.every((c) => c !== null));

    const stray = '999999';
    for (let i = 0; i < VERIFICATION_LIMITS.MAX_ATTEMPTS; i += 1) {
      await checkCode(multiEmail, VerificationPurpose.SIGNUP, stray);
    }
    // Every real code should now be dead, not just the newest.
    const oldest = await checkCode(multiEmail, VerificationPurpose.SIGNUP, codes[0]!.code);
    check(
      'a wrong guess is charged against every outstanding code',
      oldest.ok === false,
      'otherwise three codes means fifteen guesses',
    );

    console.log('\nThe outstanding-code ceiling');
    const floodEmail = addr();
    const results = [];
    for (let i = 0; i < VERIFICATION_LIMITS.MAX_OUTSTANDING + 2; i += 1) {
      results.push(await issueCode({ email: floodEmail, purpose: VerificationPurpose.SIGNUP }));
    }
    check(
      'stops issuing past the ceiling',
      results.filter((r) => r !== null).length === VERIFICATION_LIMITS.MAX_OUTSTANDING,
      `${results.filter((r) => r !== null).length} issued`,
    );

    console.log('\nExpiry');
    const expiredEmail = addr();
    const expiring = await issueCode({ email: expiredEmail, purpose: VerificationPurpose.SIGNUP });
    await prisma.verificationCode.updateMany({
      where: { email: expiredEmail },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const stale = await checkCode(expiredEmail, VerificationPurpose.SIGNUP, expiring!.code);
    check('an expired code is refused', stale.ok === false);

    console.log('\nPurposes do not cross');
    const crossEmail = addr();
    const signup = await issueCode({ email: crossEmail, purpose: VerificationPurpose.SIGNUP });
    const asReset = await checkCode(
      crossEmail,
      VerificationPurpose.PASSWORD_RESET,
      signup!.code,
    );
    check(
      'a signup code cannot reset a password',
      asReset.ok === false,
      'otherwise one code opens two doors',
    );

    console.log('\nSweeping');
    const swept = await sweepVerificationCodes();
    check('removes spent and expired codes', swept > 0, `${swept} removed`);
    const leftover = await prisma.verificationCode.count({
      where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date() } }] },
    });
    check('none left holding a password hash', leftover === 0, `${leftover} remain`);
  } finally {
    await prisma.verificationCode.deleteMany({ where: { email: { contains: '@example.test' } } });
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? '\nAll verification checks passed.' : `\n${failures} FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
