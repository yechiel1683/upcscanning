import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'CatalogForge — spreadsheet in, product catalog out',
    template: '%s · CatalogForge',
  },
  description:
    'Upload a supplier product list and get back a ZIP of professional, consistent ecommerce product images for every item.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-full antialiased">{children}</body>
    </html>
  );
}
