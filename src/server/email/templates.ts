import type { Message } from './index';

/**
 * The messages customers actually receive.
 *
 * Email is not the web. Gmail strips <style> blocks, Outlook renders through
 * Word's layout engine, and Apple Mail inverts colours for dark mode whether
 * you asked or not. So: tables for layout, every rule inline, and nothing that
 * depends on a stylesheet surviving. That is not a stylistic choice.
 *
 * Three rules from how the large platforms do this, each with a reason:
 *
 *   600px, one column   Over half of these are read on a phone. A second
 *                       column is a horizontal scroll on a 375px screen.
 *   nothing below 14px  Smaller than that is unreadable on a phone, and the
 *                       footer is where the "was this you?" reassurance lives.
 *   nothing but this    A verification email carrying a promotion loses its
 *                       transactional standing with inbox providers and starts
 *                       landing in spam — taking the codes with it.
 *
 * No images at all, including the logo. A cautious client blocks remote content
 * by default, and an email whose brand mark is a broken-image icon looks like a
 * phishing attempt rather than a company. The barcode below is drawn with table
 * cells, so it renders everywhere and cannot be blocked.
 */

const INK = '#15161a';
const MUTED = '#5c5e69';
const FAINT = '#8a8c97';
const LINE = '#e4e5ea';
const PAPER = '#ffffff';
const GROUND = '#f4f5f7';

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,monospace";

/**
 * The wordmark, drawn rather than loaded.
 *
 * Bars of varying width in a table row — the same motif as the site's own
 * mark. Because it is table cells and background colours, it survives image
 * blocking, which is exactly when a logo matters most: an email that arrives
 * looking broken is one people distrust.
 */
function wordmark(): string {
  const bars = [3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 1, 1, 3, 1, 2];
  const cells = bars
    .map(
      (width, i) =>
        `<td width="${width * 2}" style="width:${width * 2}px;background:${
          i % 2 === 0 ? INK : 'transparent'
        };font-size:0;line-height:0;">&nbsp;</td>`,
    )
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    <tr>
      <td style="padding-right:10px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" height="20" style="border-collapse:collapse;height:20px;">
          <tr>${cells}</tr>
        </table>
      </td>
      <td style="font:600 15px ${SANS};color:${INK};letter-spacing:-0.01em;white-space:nowrap;">
        UPC&nbsp;Scanning
      </td>
    </tr>
  </table>`;
}

interface Shell {
  heading: string;
  /** One sentence under the heading. The "yes, this is mine" line. */
  lede: string;
  body: string;
  /** Small print. Always says what to do if this was not them. */
  footnote: string;
}

function shell({ heading, lede, body, footnote }: Shell): string {
  return `<!doctype html>
<html lang="en" style="background:${GROUND};">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:${GROUND};-webkit-font-smoothing:antialiased;">
  <!-- Shown in the inbox list next to the subject, before anything is opened. -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${lede}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${GROUND};">
    <tr>
      <td align="center" style="padding:40px 16px;">

        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

          <tr><td style="padding:0 4px 20px 4px;">${wordmark()}</td></tr>

          <tr>
            <td style="background:${PAPER};border:1px solid ${LINE};border-radius:14px;padding:36px 36px 32px 36px;">
              <h1 style="margin:0 0 8px 0;font:600 24px/1.25 ${SANS};color:${INK};letter-spacing:-0.022em;">
                ${heading}
              </h1>
              <p style="margin:0 0 24px 0;font:400 16px/1.6 ${SANS};color:${MUTED};">
                ${lede}
              </p>
              ${body}
            </td>
          </tr>

          <tr>
            <td style="padding:22px 8px 0 8px;">
              <p style="margin:0 0 10px 0;font:400 14px/1.6 ${SANS};color:${MUTED};">
                ${footnote}
              </p>
              <p style="margin:0;font:400 13px/1.6 ${SANS};color:${FAINT};">
                UPC Scanning LLC &middot; upcscanning.com<br>
                This address is not monitored, so please do not reply to it.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * The code.
 *
 * Monospace and widely spaced so the digits cannot be misread — 0 against O
 * and 1 against l are precisely the confusions that send somebody back to
 * request a second code. Large enough to read from a notification, and real
 * selectable text rather than an image, so it can be copied.
 */
function codeBlock(code: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
    <tr>
      <td align="center" style="background:${GROUND};border:1px solid ${LINE};border-radius:12px;padding:26px 16px;">
        <div style="font:600 34px/1 ${MONO};color:${INK};letter-spacing:0.22em;text-indent:0.22em;">${code}</div>
      </td>
    </tr>
  </table>`;
}

/** A row of small facts, so a reader can confirm the message is theirs. */
function details(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([label, value]) => `<tr>
        <td style="padding:7px 0;font:400 14px/1.5 ${SANS};color:${FAINT};white-space:nowrap;">${label}</td>
        <td align="right" style="padding:7px 0;font:500 14px/1.5 ${SANS};color:${INK};">${value}</td>
      </tr>`,
    )
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${LINE};margin:0;">
    ${cells}
  </table>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

export function signupCodeEmail(to: string, code: string, minutes: number): Message {
  const safeTo = escapeHtml(to);
  return {
    // The code leads the subject because most people read it off the
    // notification and never open the message. That is the fastest this can be.
    subject: `${code} — confirm your UPC Scanning account`,
    to,
    html: shell({
      heading: 'Confirm your email',
      lede: 'Enter this code to finish creating your account.',
      body:
        codeBlock(code) +
        details([
          ['Account', safeTo],
          ['Expires in', `${minutes} minutes`],
          ['Can be used', 'Once'],
        ]),
      footnote:
        'If you did not try to create an account, you can ignore this email. Nothing has been created, and the code is useless without this message.',
    }),
    text: [
      'Confirm your email',
      '',
      `Your code is: ${code}`,
      '',
      `Account:     ${to}`,
      `Expires in:  ${minutes} minutes`,
      'Can be used: once',
      '',
      'If you did not try to create an account, you can ignore this email.',
      'Nothing has been created.',
      '',
      'UPC Scanning LLC · upcscanning.com',
      'This address is not monitored, so please do not reply to it.',
    ].join('\n'),
  };
}

export function passwordResetEmail(to: string, code: string, minutes: number): Message {
  const safeTo = escapeHtml(to);
  return {
    subject: `${code} — reset your UPC Scanning password`,
    to,
    html: shell({
      heading: 'Reset your password',
      lede: 'Enter this code to choose a new password.',
      body:
        codeBlock(code) +
        details([
          ['Account', safeTo],
          ['Expires in', `${minutes} minutes`],
          ['Can be used', 'Once'],
        ]),
      footnote:
        'If you did not ask to reset your password, ignore this email. Your password has not changed, and nobody can change it without this code.',
    }),
    text: [
      'Reset your password',
      '',
      `Your code is: ${code}`,
      '',
      `Account:     ${to}`,
      `Expires in:  ${minutes} minutes`,
      'Can be used: once',
      '',
      'If you did not ask for this, ignore this email. Your password has not',
      'changed.',
      '',
      'UPC Scanning LLC · upcscanning.com',
      'This address is not monitored, so please do not reply to it.',
    ].join('\n'),
  };
}

/** Sent by the setup page's test button. */
export function testEmail(to: string): Message {
  return {
    subject: 'UPC Scanning email test',
    to,
    html: shell({
      heading: 'Email is working',
      lede: 'This was sent by your own instance, so the key and the sending domain are both correct.',
      body: details([
        ['Sent to', escapeHtml(to)],
        ['Sent at', new Date().toUTCString()],
      ]),
      footnote:
        'Customers receive confirmation codes and password resets from this same address, laid out like this message.',
    }),
    text: [
      'Email is working.',
      '',
      'This was sent by your own instance, so the key and the sending domain',
      'are both correct. Customers receive confirmation codes and password',
      'resets from this same address.',
      '',
      `Sent to: ${to}`,
      `Sent at: ${new Date().toUTCString()}`,
      '',
      'UPC Scanning LLC · upcscanning.com',
    ].join('\n'),
  };
}
