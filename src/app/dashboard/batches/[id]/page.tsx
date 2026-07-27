import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { currentUser } from '@/server/auth/session';
import { prisma } from '@/server/db';
import { BatchClient } from './batch-client';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const user = await currentUser();
  if (!user) return { title: 'Batch' };

  const { id } = await params;
  const batch = await prisma.batch.findFirst({
    where: { id, userId: user.id },
    select: { name: true },
  });

  return { title: batch?.name ?? 'Batch' };
}

export default async function BatchPage({ params }: Props) {
  const user = await currentUser();
  if (!user) return null;

  const { id } = await params;

  // Confirm ownership server-side so a bad id 404s instead of rendering a
  // shell that then fails its first fetch.
  const batch = await prisma.batch.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!batch) notFound();

  return <BatchClient batchId={batch.id} />;
}
