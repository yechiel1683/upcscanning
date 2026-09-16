import { z } from 'zod';

import { env } from '@/lib/env';
import { limit, sameOrigin } from '@/server/api/guard';
import { handleError, ok } from '@/server/api/respond';
import { email as mailer, emailConfigured } from '@/server/email';
import { testEmail } from '@/server/email/templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ to: z.string().email('Enter a valid email address.') });

/**
 * Send one real email, and say exactly what happened.
 *
 * Email fails in two places that look identical from the outside: the API key
 * can be wrong, or the key can be fine while the sending domain has not been
 * verified with the provider. In the second case nothing leaves the building
 * and the app reports perfect health, because the rejection happens at the
 * provider. A customer's first sign of it is a confirmation code that never
 * arrives, which they will read as the product being broken.
 *
 * So this sends a real message and hands back the provider's own words.
 */
export async function POST(request: Request) {
  try {
    const forged = sameOrigin(request);
    if (forged) return forged;

    const refused = limit(request, 'setupCheck');
    if (refused) return refused;

    const { to } = schema.parse(await request.json());
    const from = env().EMAIL_FROM;

    if (!emailConfigured()) {
      return ok({
        state: 'not-configured',
        from,
        message:
          'No RESEND_API_KEY is set, so emails are printed to the server log instead ' +
          'of being sent. The signup flow works — look in the deploy logs for the code.',
      });
    }

    const result = await mailer().send(testEmail(to));

    if (!result.sent) {
      const detail = result.error ?? 'unknown error';
      // The single most common cause, and the one whose message is otherwise
      // cryptic. Worth naming rather than making somebody search for it.
      const domainProblem = /domain|verif|not allowed|from/i.test(detail);

      return ok({
        state: 'failed',
        from,
        detail,
        message: domainProblem
          ? `The provider refused to send from ${from}. That address's domain has to be ` +
            'verified in Resend first — add the DNS records it lists under Domains, then ' +
            'try again. Until then, set EMAIL_FROM to a verified address.'
          : 'The provider refused the message. The exact reason is below.',
      });
    }

    return ok({
      state: 'sent',
      from,
      id: result.id,
      message: `Sent to ${to} from ${from}. If it does not arrive within a minute, check the spam folder — that usually means the domain's DNS records are incomplete.`,
    });
  } catch (error) {
    return handleError(error);
  }
}
