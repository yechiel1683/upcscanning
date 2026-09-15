import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request security headers, and the nonce the Content-Security-Policy
 * depends on.
 *
 * A CSP is the one header that cannot be set statically here. Every page has
 * two inline scripts — the theme initialiser, which must run before first paint
 * or a light-theme visitor gets a black flash on every navigation, and the
 * JSON-LD block — plus the scripts Next injects to hydrate. Allowing those with
 * `'unsafe-inline'` would permit every *other* inline script too, which is
 * precisely the attack a CSP exists to stop, so the policy would be decoration.
 *
 * A nonce is the way out: one unguessable value per response, named in the
 * header and set on the scripts we control. An injected `<script>` has no way
 * to know it, so it does not run. `'strict-dynamic'` then lets a trusted script
 * load the chunks it needs without the policy having to list them.
 *
 * Everything this app loads is served from its own origin — no CDN, no Google
 * Fonts, no analytics — which is what makes a policy this tight practical.
 */

/** 128 bits, base64. Guessing it is not a realistic attack. */
function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function middleware(request: NextRequest) {
  const nonce = makeNonce();
  const isDev = process.env.NODE_ENV !== 'production';

  const policy = [
    "default-src 'self'",
    // strict-dynamic makes browsers that understand it ignore the host list
    // that follows; the host list is there for those that do not. Dev needs
    // eval for React Refresh; production must never have it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${isDev ? "'unsafe-eval'" : ''}`.trim(),
    // Styles stay unsafe-inline: Next injects them per-component, nonces do not
    // reach them, and an inline style cannot execute script the way a tag can.
    "style-src 'self' 'unsafe-inline'",
    // data: for the inlined brand assets, blob: for images rendered client-side.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The app talks only to its own API. A CSP cannot stop a server-side fetch,
    // so this is about what a compromised page may exfiltrate to.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // Nothing here is ever posted anywhere else.
    "form-action 'self'",
    // Supersedes X-Frame-Options in modern browsers; both are sent.
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  // Pass the nonce forward so the layout can put it on the scripts it renders.
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);

  const response = NextResponse.next({ request: { headers } });

  response.headers.set('content-security-policy', policy);
  // Belt and braces for browsers predating frame-ancestors.
  response.headers.set('x-frame-options', 'DENY');
  // Stops a browser second-guessing a content type — the trick that turns an
  // uploaded spreadsheet served as text into an executed script.
  response.headers.set('x-content-type-options', 'nosniff');
  // Barcodes and supplier names in a URL are a customer's commercial data; do
  // not hand them to whatever they click through to.
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  // Nothing here needs any of these, and saying so stops an embedded frame
  // asking on our behalf.
  response.headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );

  if (!isDev) {
    // Two years, subdomains included. Only in production: sending this from
    // localhost pins the browser to HTTPS for a host that has no certificate.
    response.headers.set(
      'strict-transport-security',
      'max-age=63072000; includeSubDomains; preload',
    );
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Every path except the static assets Next serves itself, which are
     * immutable, carry no cookies, and would only pay the cost.
     */
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
