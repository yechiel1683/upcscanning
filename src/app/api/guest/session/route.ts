import { fail, handleError, ok } from '@/server/api/respond';
import { currentGuest, endGuest, startGuest } from '@/server/guest/session';
import { GUEST_CREDITS, GUEST_MAX_PRODUCTS_PER_BATCH } from '@/server/guest/store';

export const runtime = 'nodejs';

/** Current guest session, if any. */
export async function GET() {
  try {
    const session = await currentGuest();
    if (!session) return fail('No guest session.', 404);
    return ok({ guest: summarise(session) });
  } catch (error) {
    return handleError(error);
  }
}

/** Start a guest session. No account, no database. */
export async function POST() {
  try {
    const session = await startGuest();
    return ok({ guest: summarise(session) }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE() {
  try {
    await endGuest();
    return ok({ ended: true });
  } catch (error) {
    return handleError(error);
  }
}

function summarise(session: { id: string; credits: number; expiresAt: Date }) {
  return {
    id: session.id,
    credits: session.credits,
    expiresAt: session.expiresAt,
    maxProductsPerBatch: GUEST_MAX_PRODUCTS_PER_BATCH,
    startingCredits: GUEST_CREDITS,
  };
}
