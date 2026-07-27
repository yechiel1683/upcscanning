import 'dotenv/config';

import { LedgerReason, Plan, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Development seed. Creates one account you can sign in with immediately so
 * you are not stuck at a registration form before you can try an upload.
 */

const prisma = new PrismaClient();

const DEMO_EMAIL = process.env.SEED_EMAIL ?? 'demo@catalogforge.local';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'catalogforge-demo';
const DEMO_CREDITS = 500;

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log(`Demo user already exists: ${DEMO_EMAIL}`);
    return;
  }

  await prisma.user.create({
    data: {
      email: DEMO_EMAIL,
      name: 'Demo Account',
      passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12),
      plan: Plan.GROWTH,
      credits: DEMO_CREDITS,
      ledger: {
        create: {
          delta: DEMO_CREDITS,
          reason: LedgerReason.MANUAL_ADJUSTMENT,
          note: 'Seeded development credits',
        },
      },
    },
  });

  console.log(
    [
      'Seeded a demo account:',
      `  email:    ${DEMO_EMAIL}`,
      `  password: ${DEMO_PASSWORD}`,
      `  credits:  ${DEMO_CREDITS}`,
      '',
      'Try it with the sample list at examples/sample-products.csv',
    ].join('\n'),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
