-- Shared barcode lookup cache. A GTIN identifies the same product forever and
-- supplier lists overlap heavily, so answering the same lookup twice is pure
-- waste of a metered (and, on the free tier, daily-capped) allowance.
CREATE TABLE "barcode_lookups" (
    "upc" TEXT NOT NULL,
    "facts" JSONB,
    "candidates" JSONB NOT NULL,
    "providers" TEXT[],
    "miss" BOOLEAN NOT NULL DEFAULT false,
    "hits" INTEGER NOT NULL DEFAULT 0,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "barcode_lookups_pkey" PRIMARY KEY ("upc")
);

CREATE INDEX "barcode_lookups_expiresAt_idx" ON "barcode_lookups"("expiresAt");
