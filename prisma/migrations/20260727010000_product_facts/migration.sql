-- Product details discovered during barcode/web lookup, so a bare list of
-- barcodes comes back with names, brands, and models attached.
ALTER TABLE "products" ADD COLUMN "facts" JSONB;
