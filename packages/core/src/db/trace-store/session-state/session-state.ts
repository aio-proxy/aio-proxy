import { and, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { hashSession } from '../../../protocol/session';
import { sessionAffinity, sessionResponse } from '../../schema';
import type { SessionAffinityObservation, SessionIdentity, SessionResponseResolution } from '../types';

const AFFINITY_TTL_MS = 60 * 60 * 1000;

function hashResponseId(responseId: string): `sha256:${string}` | undefined {
  const trimmed = responseId.trim();
  if (trimmed.length === 0) return undefined;
  return hashSession('response-id', trimmed);
}

export function resolveResponse(
  db: BunSQLiteDatabase,
  responseId: string,
  now: Date,
): SessionResponseResolution | undefined {
  const hash = hashResponseId(responseId);
  if (hash === undefined) return undefined;
  const row = db.select().from(sessionResponse).where(eq(sessionResponse.responseIdSha256, hash)).get();
  if (row === undefined) {
    return undefined;
  }
  // Ambiguity is a permanent security tombstone: TTL must never restore routing.
  if (row.ambiguous || row.sessionSource === null || row.sessionId === null || row.providerId === null) {
    return { status: 'ambiguous' };
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return undefined;
  }
  const newExpiry = new Date(now.getTime() + AFFINITY_TTL_MS);
  db.transaction((tx) => {
    tx.update(sessionResponse).set({ expiresAt: newExpiry }).where(eq(sessionResponse.responseIdSha256, hash)).run();
  });
  return {
    status: 'owned',
    owner: {
      identity: { source: row.sessionSource as SessionIdentity['source'], id: row.sessionId },
      providerId: row.providerId,
    },
  };
}

export function upsertResponse(
  tx: BunSQLiteDatabase,
  responseId: string,
  identity: SessionIdentity,
  providerId: string,
  now: Date,
): void {
  const hash = hashResponseId(responseId);
  if (hash === undefined) return;
  const expiresAt = new Date(now.getTime() + AFFINITY_TTL_MS);
  const existing = tx.select().from(sessionResponse).where(eq(sessionResponse.responseIdSha256, hash)).get();
  if (existing === undefined) {
    tx.insert(sessionResponse)
      .values({
        responseIdSha256: hash,
        sessionSource: identity.source,
        sessionId: identity.id,
        providerId,
        ambiguous: false,
        expiresAt,
      })
      .run();
    return;
  }
  const sameOwner =
    existing.sessionSource === identity.source &&
    existing.sessionId === identity.id &&
    existing.providerId === providerId;
  tx.update(sessionResponse)
    .set({ expiresAt, ambiguous: existing.ambiguous || !sameOwner })
    .where(eq(sessionResponse.responseIdSha256, hash))
    .run();
}

export function markResponseAmbiguous(db: BunSQLiteDatabase, responseId: string, now: Date): void {
  const hash = hashResponseId(responseId);
  if (hash === undefined) return;
  db.insert(sessionResponse)
    .values({
      responseIdSha256: hash,
      sessionSource: null,
      sessionId: null,
      providerId: null,
      ambiguous: true,
      expiresAt: new Date(now.getTime() + AFFINITY_TTL_MS),
    })
    .onConflictDoUpdate({ target: sessionResponse.responseIdSha256, set: { ambiguous: true } })
    .run();
}

export function findAffinity(
  db: BunSQLiteDatabase,
  identity: SessionIdentity,
  requestedModelId: string,
  now: Date,
): SessionAffinityObservation | undefined {
  const row = db
    .select()
    .from(sessionAffinity)
    .where(
      and(
        eq(sessionAffinity.sessionSource, identity.source),
        eq(sessionAffinity.sessionId, identity.id),
        eq(sessionAffinity.requestedModelId, requestedModelId),
      ),
    )
    .get();
  if (row === undefined) {
    return undefined;
  }
  return {
    providerId: row.providerId,
    revision: row.revision,
    active: row.expiresAt.getTime() > now.getTime(),
  };
}

export function applyAffinity(
  tx: BunSQLiteDatabase,
  identity: SessionIdentity,
  requestedModelId: string,
  providerId: string,
  observed: SessionAffinityObservation | undefined,
  now: Date,
): void {
  const expiresAt = new Date(now.getTime() + AFFINITY_TTL_MS);
  const key = {
    sessionSource: identity.source,
    sessionId: identity.id,
    requestedModelId,
  };
  if (observed === undefined) {
    tx.insert(sessionAffinity)
      .values({ ...key, providerId, revision: 1, expiresAt, updatedAt: now })
      .onConflictDoNothing()
      .run();
    return;
  }
  tx.update(sessionAffinity)
    .set({ providerId, revision: observed.revision + 1, expiresAt, updatedAt: now })
    .where(
      and(
        eq(sessionAffinity.sessionSource, identity.source),
        eq(sessionAffinity.sessionId, identity.id),
        eq(sessionAffinity.requestedModelId, requestedModelId),
        eq(sessionAffinity.revision, observed.revision),
      ),
    )
    .run();
}

export function pruneSessionState(tx: BunSQLiteDatabase, cutoff: Date): void {
  tx.delete(sessionAffinity)
    .where(sql`${sessionAffinity.expiresAt} <= ${cutoff.getTime()}`)
    .run();
  // ponytail: ambiguous rows are retained indefinitely; move them to a bounded
  // durable deny-set if collision volume becomes measurable.
  tx.delete(sessionResponse)
    .where(and(eq(sessionResponse.ambiguous, false), sql`${sessionResponse.expiresAt} <= ${cutoff.getTime()}`))
    .run();
}
