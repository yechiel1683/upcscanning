import { Resend } from 'resend';

import { env } from '@/lib/env';

/**
 * Sending email.
 *
 * A driver behind an interface, the same shape as storage and the queue, for
 * the same reason: `npm run dev` on a laptop must not need an account
 * somewhere, and a test must never send a real message to a real person.
 *
 *  - resend  — production
 *  - console — prints the message and the code to stdout, which is what makes
 *              the signup flow developable without a mailbox
 *  - null    — silently discards, for tests
 *
 * Every send reports whether it worked rather than throwing. A verification
 * email that fails to send is a real failure the caller must handle — the
 * customer is standing at a "check your inbox" screen — but it is not an
 * exception that should take down the request that triggered it.
 */

export interface Message {
  to: string;
  subject: string;
  html: string;
  /** Always supplied. Some clients refuse HTML, and spam filters weigh it. */
  text: string;
}

export interface SendResult {
  sent: boolean;
  /** Provider id, useful when someone says a message never arrived. */
  id?: string;
  error?: string;
}

export interface EmailDriver {
  readonly name: string;
  send(message: Message): Promise<SendResult>;
}

class ResendDriver implements EmailDriver {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: Message): Promise<SendResult> {
    const client = new Resend(this.apiKey);

    // The SDK returns errors in the result rather than throwing, so a
    // try/catch alone would report every failure as a success.
    const { data, error } = await client.emails.send({
      from: this.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    });

    if (error) {
      return { sent: false, error: `${error.name}: ${error.message}` };
    }
    return { sent: true, id: data?.id };
  }
}

/**
 * Prints instead of sending.
 *
 * The verification code goes to stdout deliberately: without it, developing
 * the signup flow means either a real mailbox or commenting the check out, and
 * the second one has a habit of reaching production.
 */
class ConsoleDriver implements EmailDriver {
  readonly name = 'console';

  async send(message: Message): Promise<SendResult> {
    console.log(
      [
        '',
        '─'.repeat(64),
        `  EMAIL (not actually sent — no email provider configured)`,
        `  To:      ${message.to}`,
        `  Subject: ${message.subject}`,
        '',
        message.text
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n'),
        '─'.repeat(64),
        '',
      ].join('\n'),
    );
    return { sent: true, id: 'console' };
  }
}

class NullDriver implements EmailDriver {
  readonly name = 'null';
  async send(): Promise<SendResult> {
    return { sent: true, id: 'null' };
  }
}

let driver: EmailDriver | null = null;

export function email(): EmailDriver {
  if (driver) return driver;
  const config = env();

  if (config.NODE_ENV === 'test') {
    driver = new NullDriver();
  } else if (config.RESEND_API_KEY) {
    driver = new ResendDriver(config.RESEND_API_KEY, config.EMAIL_FROM);
  } else {
    driver = new ConsoleDriver();
  }
  return driver;
}

/** True when real messages will actually leave the building. */
export function emailConfigured(): boolean {
  return Boolean(env().RESEND_API_KEY);
}

/** Test hook. */
export function resetEmailDriver(): void {
  driver = null;
}
