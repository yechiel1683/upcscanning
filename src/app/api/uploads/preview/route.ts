import { env } from '@/lib/env';
import { CANONICAL_FIELDS } from '@/lib/types';
import { fail, handleError, ok, withUser } from '@/server/api/respond';
import { readUploadForm, UploadError } from '@/server/api/upload';
import { mappingIsUsable } from '@/server/ingest/column-mapper';
import { IngestError, parseSpreadsheet } from '@/server/ingest/parser';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Dry run. Parses the spreadsheet and reports what we think the columns mean,
 * plus a sample of the products, so the user can correct the mapping before
 * spending credits on 1,000 rows.
 */
export const POST = withUser(async (_user, request) => {
  try {
    const form = await readUploadForm(request);

    const result = await parseSpreadsheet(form.buffer, form.fileName, {
      mappingOverride: form.mapping,
      maxProducts: env().MAX_PRODUCTS_PER_BATCH,
    });

    return ok({
      fileName: form.fileName,
      fileSizeBytes: form.buffer.byteLength,
      headers: result.headers,
      mapping: result.mapping,
      unmappedHeaders: result.headers.filter(
        (h) => !Object.values(result.mapping).includes(h),
      ),
      mappable: CANONICAL_FIELDS,
      usable: mappingIsUsable(result.mapping),
      totalRows: result.totalRows,
      productCount: result.products.length,
      skippedCount: result.skipped.length,
      sample: result.products.slice(0, 10),
      skipped: result.skipped.slice(0, 25),
      warnings: result.warnings.slice(0, 25),
    });
  } catch (error) {
    if (error instanceof UploadError) return fail(error.message, error.status);
    if (error instanceof IngestError) return fail(error.message, 422);
    return handleError(error);
  }
});
