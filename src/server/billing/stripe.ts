import Stripe from 'stripe';

import { env } from '@/lib/env';
import type { Pack } from '@/lib/packs';

/**
 * The Stripe client, and the two operations this app performs with it.
 *
 * Deliberately thin. Everything about what a pack contains lives in
 * `lib/packs.ts`, and everything about crediting an account lives in
 * `billing/credit.ts`; this file is the boundary where money is requested and
 * nothing else. Keeping it that way is what makes the rest testable without a
 * network.
 */

let client: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(env().STRIPE_SECRET_KEY);
}

export function stripe(): Stripe {
  if (client) return client;

  const key = env().STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      'STRIPE_SECRET_KEY is not set, so payments are not available on this instance.',
    );
  }

  client = new Stripe(key, {
    // Pinned, not floating. An API version that moves on its own turns a
    // Stripe release into an outage nobody deployed.
    apiVersion: '2026-08-26.dahlia',
    typescript: true,
    // Payments must not be abandoned because one request was slow.
    maxNetworkRetries: 2,
  });
  return client;
}

/** Live keys start `sk_live_`; test keys `sk_test_`. Worth saying out loud. */
export function stripeMode(): 'live' | 'test' | 'unset' {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) return 'unset';
  return key.startsWith('sk_live_') ? 'live' : 'test';
}

export interface CheckoutRequest {
  pack: Pack;
  userId: string;
  email: string;
  /** Where Stripe sends the customer back to. */
  appUrl: string;
}

/**
 * Open a Checkout Session for one pack.
 *
 * The price is built here from our own pack definition rather than referencing
 * a Price object configured in the Stripe dashboard. That means the number a
 * customer is charged and the number of credits they receive come from the
 * same source, and cannot drift apart because somebody edited one of them in a
 * web UI months later.
 *
 * `metadata` carries what the webhook needs to act. The webhook cannot trust
 * anything else: it is an unauthenticated endpoint, and everything in the
 * payload is only as good as the signature check that precedes it.
 */
export async function createCheckout(input: CheckoutRequest): Promise<{
  sessionId: string;
  url: string;
}> {
  const { pack, userId, email, appUrl } = input;

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: pack.currency,
          unit_amount: pack.amount,
          product_data: {
            name: `${pack.name} — ${pack.credits.toLocaleString()} product images`,
            description: pack.blurb,
          },
        },
      },
    ],
    // Read back by the webhook after the signature is verified.
    metadata: { userId, packId: pack.id, credits: String(pack.credits) },
    success_url: `${appUrl}/dashboard/billing?purchase=success`,
    cancel_url: `${appUrl}/dashboard/billing?purchase=cancelled`,
    // Credits do not expire and are consumed immediately, so an invoice is
    // the only thing a customer needs afterwards.
    invoice_creation: { enabled: true },
  });

  if (!session.url) {
    throw new Error('Stripe created a checkout session without a URL to send the customer to.');
  }

  return { sessionId: session.id, url: session.url };
}

/**
 * Verify that a webhook really came from Stripe.
 *
 * This is the only thing standing between the endpoint and anybody on the
 * internet granting themselves credits by posting a JSON body that says a
 * payment succeeded. The raw request text must be passed through unparsed —
 * the signature covers the exact bytes, so `JSON.parse` followed by
 * `JSON.stringify` invalidates it even though the object is identical.
 */
export function verifyWebhook(rawBody: string, signature: string | null): Stripe.Event {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set, so webhooks cannot be verified.');
  }
  if (!signature) {
    throw new Error('Missing Stripe signature header.');
  }

  return stripe().webhooks.constructEvent(rawBody, signature, secret);
}
