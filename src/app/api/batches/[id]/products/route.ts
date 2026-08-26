import { ProductStatus } from '@prisma/client';

import { notFound, ok, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';

type Params = { params: Promise<{ id: string }> };

const PAGE_SIZE = 50;

/**
 * Paginated product list for the batch detail view. Supports filtering by
 * status so the "failed products" tab is a single query.
 */
export const GET = withUser(async (user, request, { params }: Params) => {
  const { id } = await params;

  const batch = await prisma.batch.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  });
  if (!batch) return notFound('Batch');

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  const search = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
  const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? PAGE_SIZE) || PAGE_SIZE, 200);

  const status =
    statusParam && statusParam in ProductStatus
      ? (statusParam as ProductStatus)
      : undefined;

  const where = {
    batchId: id,
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { sku: { contains: search, mode: 'insensitive' as const } },
            { upc: { contains: search } },
            { brand: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      orderBy: { rowNumber: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        rowNumber: true,
        sku: true,
        upc: true,
        name: true,
        brand: true,
        model: true,
        category: true,
        price: true,
        status: true,
        attempts: true,
        errorMessage: true,
        reviewReason: true,
        outputName: true,
        processedAt: true,
        images: {
          where: { isPrimary: true },
          take: 1,
          select: {
            id: true,
            kind: true,
            fileName: true,
            width: true,
            height: true,
            bytes: true,
            provider: true,
            sourceUrl: true,
            matchScore: true,
            qualityScore: true,
          },
        },
      },
    }),
  ]);

  return ok({
    products: products.map((product) => ({
      ...product,
      price: product.price ? Number(product.price) : null,
      image: product.images[0] ?? null,
      images: undefined,
    })),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
});
