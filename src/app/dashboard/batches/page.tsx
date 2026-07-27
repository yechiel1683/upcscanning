import type { Metadata } from 'next';
import Link from 'next/link';
import { BatchStatus } from '@prisma/client';

import { BatchStatusBadge } from '@/components/status';
import { Card, EmptyState, formatDate, LinkButton, ProgressBar } from '@/components/ui';
import { currentUser } from '@/server/auth/session';
import { prisma } from '@/server/db';

export const metadata: Metadata = { title: 'Batches' };
export const dynamic = 'force-dynamic';

export default async function BatchesPage() {
  const user = await currentUser();
  if (!user) return null;

  const batches = await prisma.batch.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      name: true,
      status: true,
      originalFile: true,
      totalProducts: true,
      processedCount: true,
      successCount: true,
      failedCount: true,
      createdAt: true,
      completedAt: true,
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-950">Batches</h1>
          <p className="mt-1 text-sm text-ink-500">Every product list you have uploaded.</p>
        </div>
        <LinkButton href="/dashboard/upload">New upload</LinkButton>
      </div>

      <Card>
        {batches.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            description="Your uploads will appear here with their progress and downloads."
            action={<LinkButton href="/dashboard/upload">Upload a product list</LinkButton>}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-ink-200 bg-ink-50 text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-5 py-3 font-medium">Batch</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Products</th>
                  <th className="px-5 py-3 font-medium">Images</th>
                  <th className="px-5 py-3 font-medium">Uploaded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {batches.map((batch) => {
                  const percent =
                    batch.totalProducts === 0
                      ? 0
                      : Math.round((batch.processedCount / batch.totalProducts) * 100);
                  const running =
                    batch.status === BatchStatus.PROCESSING || batch.status === BatchStatus.QUEUED;

                  return (
                    <tr key={batch.id} className="transition hover:bg-ink-50">
                      <td className="px-5 py-3.5">
                        <Link
                          href={`/dashboard/batches/${batch.id}`}
                          className="font-medium text-ink-900 hover:text-accent-600"
                        >
                          {batch.name}
                        </Link>
                        <p className="mt-0.5 truncate text-xs text-ink-500">{batch.originalFile}</p>
                      </td>
                      <td className="px-5 py-3.5">
                        <BatchStatusBadge status={batch.status} />
                        {running ? (
                          <div className="mt-2 w-28">
                            <ProgressBar percent={percent} />
                          </div>
                        ) : null}
                      </td>
                      <td className="px-5 py-3.5 tabular-nums text-ink-600">
                        {batch.totalProducts.toLocaleString()}
                      </td>
                      <td className="px-5 py-3.5 tabular-nums text-ink-600">
                        {batch.successCount.toLocaleString()}
                        {batch.failedCount > 0 ? (
                          <span className="ml-1.5 text-xs text-danger-600">
                            {batch.failedCount.toLocaleString()} failed
                          </span>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3.5 text-ink-500">
                        {formatDate(batch.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
