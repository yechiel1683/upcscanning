import { z } from 'zod';

import { handleError, ok, withUser } from '@/server/api/respond';
import { generateApiKey } from '@/server/auth/session';
import { prisma } from '@/server/db';

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const GET = withUser(async (user) => {
  const apiKeys = await prisma.apiKey.findMany({
    where: { userId: user.id, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true },
  });
  return ok({ apiKeys });
});

/** Create a key. The plaintext value is returned once and never again. */
export const POST = withUser(async (user, request) => {
  try {
    const body = createSchema.parse(await request.json());
    const { key, prefix, hash } = generateApiKey();

    const record = await prisma.apiKey.create({
      data: { userId: user.id, name: body.name, prefix, keyHash: hash },
      select: { id: true, name: true, prefix: true, createdAt: true },
    });

    return ok({ apiKey: record, key }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
});

const revokeSchema = z.object({ id: z.string() });

export const DELETE = withUser(async (user, request) => {
  try {
    const body = revokeSchema.parse(await request.json());
    await prisma.apiKey.updateMany({
      where: { id: body.id, userId: user.id },
      data: { revokedAt: new Date() },
    });
    return ok({ revoked: true });
  } catch (error) {
    return handleError(error);
  }
});
