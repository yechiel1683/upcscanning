import type Stripe from 'stripe';

import { findPack } from '@/lib/packs';
import { creditPurchase, refundPurchase } from '@/server/billing/credit';
import { verifyWebhook } from '@/server/billing/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Where Stripe tells us a payment happened.
 *
 * Three properties this endpoint must have, each for a different reason:
 *
 * 1. It verifies the signature before reading anything. Without that, this is
 *    a public URL where anyone can grant themselves credits by posting JSON
 *    that says a payment succeeded.
 *
 * 2. It reads the *raw* body. The signature covers the exact bytes Stripe
 *    sent, so parsing and re-serialising invalidates it even though the object
 *    is identical. That is why there is no `request.json()` here.
 *
 * 3. It returns 2xx for anything it has handled, including events it chooses
 *    to ignore and deliveries it has already processed. Stripe retries until
 *    it gets a 2xx, so a 500 for an event we will never handle becomes an
 *    endless redelivery loop against production.
 *
 * It returns 5xx only when the work genuinely did not happen and retrying
 * might help — a database that was briefly unreachable, say. That is precisely
 * the case where Stripe retrying is what saves the customer's credits.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  const signature = request.headers.get('stripe-signature');

  let event: Stripe.Event;
  try {
    event = verifyWebhook(raw, signature);
  } catch (error) {
    // 400, not 500: an unverifiable payload is not going to become verifiable
    // on a retry, and telling Stripe to try again would be pointless load.
    const message = error instanceof Error ? error.message : 'invalid signature';
    console.warn('[billing] rejected an unverifiable webhook:', message);
    return Response.json({ error: 'Signature verification failed.' }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;

        // `payment_status` is the one that says money actually moved. A
        // completed session with an unpaid status happens with asynchronous
        // methods that can still fail afterwards.
        if (session.payment_status !== 'paid') {
          console.log(`[billing] session ${session.id} completed but is not paid yet`);
          return Response.json({ received: true });
        }

        const outcome = await handleCompletedCheckout(session);
        return Response.json({ received: true, ...outcome });
      }

      case 'charge.refunded': {
        const charge = event.data.object;
        // Stripe identifies the charge, not the checkout session, so the
        // purchase is found by payment intent.
        const sessionId = await sessionIdForPaymentIntent(charge.payment_intent);
        if (!sessionId) {
          console.warn(`[billing] refund for a charge with no purchase on record: ${charge.id}`);
          return Response.json({ received: true });
        }
        await refundPurchase(sessionId);
        return Response.json({ received: true });
      }

      default:
        // Acknowledged rather than errored. Stripe sends plenty we do not act
        // on, and every one of those must not become a retry loop.
        return Response.json({ received: true, ignored: event.type });
    }
  } catch (error) {
    // The work did not happen and a retry might succeed. This is the one case
    // where a 5xx is the right answer: Stripe redelivering is what rescues a
    // customer who has paid and not been credited.
    console.error(`[billing] failed to handle ${event.type}`, error);
    return Response.json({ error: 'Handler failed; please retry.' }, { status: 500 });
  }
}

async function handleCompletedCheckout(session: Stripe.Checkout.Session) {
  const userId = session.metadata?.userId;
  const packId = session.metadata?.packId;

  if (!userId || !packId) {
    // Nothing to act on and nothing a retry fixes. Logged loudly because it
    // means a session was created somewhere that did not set metadata, and a
    // customer has paid for something we cannot attribute.
    console.error(`[billing] session ${session.id} has no userId/packId metadata`);
    return { credited: false, reason: 'missing-metadata' };
  }

  const pack = findPack(packId);
  if (!pack) {
    console.error(`[billing] session ${session.id} names unknown pack ${packId}`);
    return { credited: false, reason: 'unknown-pack' };
  }

  // The credits come from our own pack definition, not from the metadata.
  // Metadata survives a signature check, but it is still a value that was put
  // into a request once and could have been created by an older version of
  // this code with different numbers in it.
  const outcome = await creditPurchase({
    stripeSessionId: session.id,
    stripePaymentIntentId:
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? null),
    userId,
    packId: pack.id,
    credits: pack.credits,
    // What Stripe says was charged, so the record reflects the money rather
    // than the intention. They differ if a price changed between the session
    // opening and the customer paying.
    amount: session.amount_total ?? pack.amount,
    currency: session.currency ?? pack.currency,
  });

  if (outcome.credited) {
    console.log(`[billing] credited ${pack.credits} to ${userId} for ${session.id}`);
  } else {
    console.log(`[billing] ${session.id} was already processed; no credits granted`);
  }

  return outcome;
}

/** Find the checkout session a payment intent belongs to, for refunds. */
async function sessionIdForPaymentIntent(
  paymentIntent: string | Stripe.PaymentIntent | null,
): Promise<string | null> {
  const id = typeof paymentIntent === 'string' ? paymentIntent : (paymentIntent?.id ?? null);
  if (!id) return null;

  const { prisma } = await import('@/server/db');
  const purchase = await prisma.purchase.findFirst({
    where: { stripePaymentIntentId: id },
    select: { stripeSessionId: true },
  });
  return purchase?.stripeSessionId ?? null;
}
