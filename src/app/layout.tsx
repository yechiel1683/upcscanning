import type { Metadata, Viewport } from 'next';

import { BRAND, COMPANY, DOMAIN } from '@/components/brand';
import { themeInitScript } from '@/components/theme';
import './globals.css';

const SITE_URL = process.env.APP_URL || `https://${DOMAIN}`;
const TAGLINE = 'Barcodes in. Professional product images out.';
const DESCRIPTION =
  'Upload a product list or paste a column of barcodes, and get back professional, consistent ecommerce product images for every item — packaged as a ZIP with the product details filled in.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${BRAND} — barcodes in, product images out`,
    template: `%s · ${BRAND}`,
  },
  description: DESCRIPTION,
  applicationName: BRAND,
  keywords: [
    'UPC lookup', 'barcode to product image', 'bulk product images',
    'ecommerce product photography', 'product catalog automation', 'GTIN',
  ],
  openGraph: {
    type: 'website',
    siteName: BRAND,
    url: SITE_URL,
    title: `${BRAND} — ${TAGLINE}`,
    description: DESCRIPTION,
    images: [{ url: '/og.png', width: 1200, height: 630, alt: BRAND }],
  },
  twitter: {
    card: 'summary_large_image',
    title: BRAND,
    description: TAGLINE,
    images: ['/og.png'],
  },
  // Several sizes on purpose: browsers prefer the SVG, Google's crawler wants a
  // square raster that is a multiple of 48, and iOS applies its own mask.
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
    shortcut: ['/favicon.ico'],
  },
  alternates: { canonical: SITE_URL },
};

export const viewport: Viewport = {
  // Black is the default theme whatever the OS prefers, so the browser chrome
  // matches it unconditionally rather than following prefers-color-scheme.
  themeColor: '#000000',
};

/**
 * Organization data is what Google reads to associate a logo with the site in
 * search results and the knowledge panel — a favicon alone does not do it.
 */
const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: BRAND,
  legalName: COMPANY,
  url: SITE_URL,
  logo: `${SITE_URL}/icon-512.png`,
  image: `${SITE_URL}/og.png`,
  description: DESCRIPTION,
  slogan: TAGLINE,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Blocking on purpose: it must run before first paint, or a visitor who
            chose the light theme sees a black flash on every navigation. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
      </head>
      <body className="min-h-full bg-canvas text-fg antialiased">{children}</body>
    </html>
  );
}
