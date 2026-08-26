import { randomBytes } from 'node:crypto';

import type { ImageSourceKind } from '@prisma/client';

import type { ParsedProduct, ProductFacts, RenderOptions } from '@/lib/types';
import type { Alternative } from '@/server/pipeline/process-product';

/**
 * Guest sessions: the whole product, with no account and no database.
 *
 * This exists because setting up Postgres is a real barrier to answering the
 * only question a new user has — does this actually work on my products? The
 * pipeline was already written to be pure with respect to the database
 * (processProduct takes a plain product and returns a decision), so the only
 * thing standing between "no database" and "usable" was somewhere to put the
 * results. That is what this is.
 *
 * Everything lives in this process. It is deliberately capped and expiring:
 * unbounded in-memory state on a public endpoint is a denial-of-service
 * waiting to happen, and a guest who is told their work is temporary should
 * find that it genuinely is.
 */

export const GUEST_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
export const GUEST_CREDITS = 100;
export const GUEST_MAX_PRODUCTS_PER_BATCH = 100;
export const GUEST_MAX_BATCHES = 5;

/**
 * Sessions are bigger now, so there can be fewer of them.
 *
 * A guest holds finished JPEGs in this process's memory, and at a hundred
 * images a session that is tens of megabytes rather than a few. The count
 * ceiling alone stopped meaning anything the moment the per-session size
 * changed, so the real limit below is bytes.
 */
const MAX_SESSIONS = 60;

/**
 * Total image bytes all guests may hold between them.
 *
 * This is the number that actually protects the container. Raising the batch
 * limit from twenty-five to a hundred multiplies what one guest can pin in
 * memory by four, and memory is what gets this process killed — so the ceiling
 * has to be on the thing being consumed, not on how many people are consuming
 * it. Over budget, the least recently active sessions go first.
 */
const MEMORY_BUDGET_BYTES = 320 * 1024 * 1024;

export type GuestProductStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'NEEDS_REVIEW'
  | 'FAILED';
export type GuestBatchStatus = 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'COMPLETED_WITH_ERRORS';

export interface GuestImage {
  id: string;
  kind: ImageSourceKind;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  provider: string | null;
  sourceUrl: string | null;
  matchScore: number;
  qualityScore: number;
  /** Held in memory rather than storage: a guest's output is never persisted. */
  buffer: Buffer;
}

export interface GuestProduct extends ParsedProduct {
  id: string;
  status: GuestProductStatus;
  errorMessage: string | null;
  /** Why this needs a human glance, when it does. */
  reviewReason: string | null;
  /** How many escalating passes this row has had. */
  attempts: number;
  /**
   * Other credible pictures of the same product, best first, so an uncertain
   * row can be corrected rather than only accepted or emptied. Just URLs and
   * scores — the swap renders on demand.
   */
  alternatives: Alternative[];
  facts: ProductFacts | null;
  outputName: string | null;
  image: GuestImage | null;
}

export interface GuestBatch {
  id: string;
  name: string;
  originalFile: string;
  status: GuestBatchStatus;
  options: RenderOptions;
  products: GuestProduct[];
  createdAt: Date;
  completedAt: Date | null;
  /** Built ZIP, kept until the session expires. */
  zip: { fileName: string; buffer: Buffer; imageCount: number } | null;
}

export interface GuestSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  credits: number;
  batches: GuestBatch[];
}

const sessions = new Map<string, GuestSession>();

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

/** Drop expired sessions. Called on every access, so no timer is needed. */
function sweep(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt.getTime() <= now) sessions.delete(id);
  }

  // Hard ceiling as a backstop: evict the oldest if something goes wrong with
  // expiry, so memory cannot grow without bound.
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, sessions.size - MAX_SESSIONS);
    for (const session of oldest) sessions.delete(session.id);
  }

  evictUntilUnderBudget();
}

/** Image and ZIP bytes a session is holding. */
function sessionBytes(session: GuestSession): number {
  let total = 0;
  for (const batch of session.batches) {
    total += batch.zip?.buffer.byteLength ?? 0;
    for (const product of batch.products) total += product.image?.buffer.byteLength ?? 0;
  }
  return total;
}

export function guestBytesInUse(): number {
  let total = 0;
  for (const session of sessions.values()) total += sessionBytes(session);
  return total;
}

/**
 * Drop whole sessions, oldest first, until the process is back inside budget.
 *
 * Whole sessions rather than individual images: a guest with half their batch
 * silently missing has a broken product, while a guest whose expired session is
 * gone has an understandable one.
 */
function evictUntilUnderBudget(): void {
  let total = guestBytesInUse();
  if (total <= MEMORY_BUDGET_BYTES) return;

  const byAge = [...sessions.values()].sort(
    (a, b) => a.expiresAt.getTime() - b.expiresAt.getTime(),
  );
  for (const session of byAge) {
    if (total <= MEMORY_BUDGET_BYTES) break;
    total -= sessionBytes(session);
    sessions.delete(session.id);
  }
}

export function createGuestSession(): GuestSession {
  sweep();
  const now = new Date();
  const session: GuestSession = {
    id: newId('guest'),
    createdAt: now,
    expiresAt: new Date(now.getTime() + GUEST_TTL_MS),
    credits: GUEST_CREDITS,
    batches: [],
  };
  sessions.set(session.id, session);
  return session;
}

export function getGuestSession(id: string | undefined): GuestSession | null {
  if (!id) return null;
  sweep();
  const session = sessions.get(id);
  if (!session) return null;
  // Touch: an active guest should not expire mid-batch.
  session.expiresAt = new Date(Date.now() + GUEST_TTL_MS);
  return session;
}

export function createGuestBatch(
  session: GuestSession,
  input: {
    name: string;
    originalFile: string;
    options: RenderOptions;
    products: ParsedProduct[];
  },
): GuestBatch {
  const batch: GuestBatch = {
    id: newId('gb'),
    name: input.name,
    originalFile: input.originalFile,
    status: 'QUEUED',
    options: input.options,
    createdAt: new Date(),
    completedAt: null,
    zip: null,
    products: input.products.map((product) => ({
      ...product,
      id: newId('gp'),
      status: 'PENDING',
      errorMessage: null,
      reviewReason: null,
      attempts: 0,
      alternatives: [],
      facts: null,
      outputName: null,
      image: null,
    })),
  };

  session.batches.unshift(batch);
  // Keep only the most recent batches so a long-lived session cannot
  // accumulate image buffers indefinitely.
  session.batches = session.batches.slice(0, GUEST_MAX_BATCHES);
  return batch;
}

export function findGuestBatch(session: GuestSession, batchId: string): GuestBatch | null {
  return session.batches.find((batch) => batch.id === batchId) ?? null;
}

/** A product in this session, and only this session. */
/**
 * Locate a product within one guest's own sessions.
 *
 * Returns the batch alongside it because every caller that changes a product
 * has to settle the batch afterwards, and looking it up separately invites
 * updating a row while its batch still claims the old summary.
 */
export function findGuestProduct(
  session: GuestSession,
  productId: string,
): { product: GuestProduct; batch: GuestBatch } | null {
  for (const batch of session.batches) {
    const product = batch.products.find((candidate) => candidate.id === productId);
    if (product) return { product, batch };
  }
  return null;
}

export function findGuestImage(
  session: GuestSession,
  imageId: string,
): GuestImage | null {
  for (const batch of session.batches) {
    for (const product of batch.products) {
      if (product.image?.id === imageId) return product.image;
    }
  }
  return null;
}

export function newImageId(): string {
  return newId('gi');
}

/** Recompute a batch's terminal status from its products. */
export function settleGuestBatch(batch: GuestBatch): void {
  const pending = batch.products.some(
    (product) => product.status === 'PENDING' || product.status === 'PROCESSING',
  );
  if (pending) {
    batch.status = 'PROCESSING';
    return;
  }
  const failed = batch.products.some((product) => product.status === 'FAILED');
  batch.status = failed ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
  batch.completedAt = new Date();
}

/** Test and diagnostics hook. */
export function guestSessionCount(): number {
  sweep();
  return sessions.size;
}

export function resetGuestStore(): void {
  sessions.clear();
}
