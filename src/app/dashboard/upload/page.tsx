import type { Metadata } from 'next';

import { UploadModeSwitch } from './mode-switch';

export const metadata: Metadata = { title: 'New upload' };

export default function UploadPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">New upload</h1>
        <p className="mt-1 text-sm text-muted">
          Give us a product list or just a column of barcodes — we build a professional image
          for every item, and fill in the details we find along the way.
        </p>
      </div>

      <UploadModeSwitch />
    </div>
  );
}
