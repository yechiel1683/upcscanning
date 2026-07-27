import type { Metadata } from 'next';

import { UploadClient } from './upload-client';

export const metadata: Metadata = { title: 'New upload' };

export default function UploadPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-950">New upload</h1>
        <p className="mt-1 text-sm text-ink-500">
          Upload a supplier product list and we will build a professional image for every row.
        </p>
      </div>

      <UploadClient />
    </div>
  );
}
