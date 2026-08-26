-- A row that came back empty is retried automatically at a wider and then a
-- more forgiving setting. The last rung accepts a weaker match rather than
-- returning nothing, so its results need somewhere to sit that is neither
-- "done" nor "failed" until a person has looked at them.
--
-- Enum values cannot be added inside a transaction that also uses them on some
-- PostgreSQL versions, so this migration only adds the value and the column.
ALTER TYPE "ProductStatus" ADD VALUE IF NOT EXISTS 'NEEDS_REVIEW' AFTER 'SUCCEEDED';

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "reviewReason" TEXT;
