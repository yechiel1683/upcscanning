import { notFound, ok, withUser } from '@/server/api/respond';
import { prisma } from '@/server/db';

type Params = { params: Promise<{ id: string }> };

/**
 * Full detail for one product, including the candidate audit trail: every
 * image we considered, its scores, and why it was rejected. This is what makes
 * a wrong match debuggable instead of mysterious.
 */
export const GET = withUser(async (user, _request, { params }: Params) => {
  const { id } = await params;

  const product = await prisma.product.findFirst({
    where: { id, batch: { userId: user.id } },
    include: {
      images: true,
      candidates: { orderBy: [{ selected: 'desc' }, { matchScore: 'desc' }], take: 25 },
      batch: { select: { id: true, name: true } },
    },
  });
  if (!product) return notFound('Product');

  return ok({
    product: {
      id: product.id,
      batch: product.batch,
      rowNumber: product.rowNumber,
      sku: product.sku,
      upc: product.upc,
      name: product.name,
      brand: product.brand,
      model: product.model,
      description: product.description,
      category: product.category,
      price: product.price ? Number(product.price) : null,
      extra: product.extra,
      status: product.status,
      attempts: product.attempts,
      errorMessage: product.errorMessage,
      enrichment: product.enrichment,
      outputName: product.outputName,
      processedAt: product.processedAt,
    },
    images: product.images,
    candidates: product.candidates,
  });
});
