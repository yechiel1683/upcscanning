import { Badge } from './ui';

/** Status vocabulary shared by every view, so a colour always means one thing. */

const BATCH_LABELS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' }> = {
  UPLOADED: { label: 'Uploaded', tone: 'neutral' },
  MAPPING: { label: 'Mapping', tone: 'neutral' },
  QUEUED: { label: 'Queued', tone: 'accent' },
  PROCESSING: { label: 'Processing', tone: 'accent' },
  COMPLETED: { label: 'Completed', tone: 'positive' },
  COMPLETED_WITH_ERRORS: { label: 'Completed with errors', tone: 'warning' },
  FAILED: { label: 'Failed', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function BatchStatusBadge({ status }: { status: string }) {
  const entry = BATCH_LABELS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

const PRODUCT_LABELS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' }> = {
  PENDING: { label: 'Pending', tone: 'neutral' },
  PROCESSING: { label: 'Processing', tone: 'accent' },
  SUCCEEDED: { label: 'Done', tone: 'positive' },
  NEEDS_REVIEW: { label: 'Check this one', tone: 'warning' },
  FAILED: { label: 'Failed', tone: 'danger' },
  SKIPPED: { label: 'Skipped', tone: 'neutral' },
};

export function ProductStatusBadge({ status }: { status: string }) {
  const entry = PRODUCT_LABELS[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}

const KIND_LABELS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'positive' | 'warning' }> = {
  REAL: { label: 'Real photo', tone: 'positive' },
  USER_PROVIDED: { label: 'From your file', tone: 'accent' },
  AI_GENERATED: { label: 'AI generated', tone: 'warning' },
};

/**
 * Provenance is the one thing a buyer must never have to guess at, so the
 * AI-generated badge is styled to stand out rather than blend in.
 */
export function ImageKindBadge({ kind }: { kind: string }) {
  const entry = KIND_LABELS[kind] ?? { label: kind, tone: 'neutral' as const };
  return <Badge tone={entry.tone}>{entry.label}</Badge>;
}
