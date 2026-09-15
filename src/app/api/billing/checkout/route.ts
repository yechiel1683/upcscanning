import { z } from 'zod';

import { env } from '@/lib/env';
import { findPack } from '@/lib/packs';
import { limit } from '@/server/api/guard';
import { fail, handleError, ok, withUser } from '@/server/api/respond';
import { createCheckout, stripeConfigured } from '@/server/billing/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ packId: z.string().min(1).max(64) });

/**
 * Start a purchase, returning the Stripe-hosted page to send the customer to.
 *
 * The pack is looked up by id on the server and its price read from our own
 * definition. A client that posts an amount is a client that can post a
 * different amount, so the request carries only which pack was chosen.
 */
export const POST = withUser(async (user, request) => {
  try {
    const refused = limit(request, 'checkout');
    if (refused) return refused;

    if (!stripeConfigured()) {
      return fail('Payments are not set up on this instance yet.', 503);
    }

    const { packId } = schema.parse(await request.json());
    const pack = findPack(packId);
    if (!pack) return fail('That is not a pack we sell.', 400);

    const { sessionId, url } = await createCheckout({
      pack,
      userId: user.id,
      email: user.email,
      appUrl: env().APP_URL,
    });

    return ok({ sessionId, url });
  } catch (error) {
    return handleError(error);
  }
});
