import { and, eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { sessionAffinity, sessionResponse } from '../../schema';
import type { SessionAffinityObservation, SessionIdentity } from '../types';

const AFFINITY_TTL_MS = 60 * 60 * 1000;

function hashResponseId(responseId: string): string {
  const trimmed = responseId.trim();
  if (trimmed.length === 0) {
    throw new Error('Response ID must not be empty');
  }
  return new Bun.CryptoHasher('sha256').update(trimmed).digest('hex');
}

export function resolveResponse(db: BunSQLiteDatabase, responseId: string, now: Date): SessionIdentity | undefined {
  const hash = hashResponseId(responseId);
  const row = db.select().from(sessionResponse).where(eq(sessionResponse.responseIdSha256, hash)).get();
  if (row === undefined) {
    return undefined;
  }
  if (row.expiresAt.getTime() <= now.getTime()) {
    return undefined;
  }
  const newExpiry = new Date(now.getTime() + AFFINITY_TTL_MS);
  db.transaction((tx) => {
    tx.update(sessionResponse).set({ expiresAt: newExpiry }).where(eq(sessionResponse.responseIdSha256, hash)).run();
  });
  return { source: row.sessionSource, id: row.sessionId };
}

export function upsertResponse(tx: BunSQLiteDatabase, responseId: string, identity: SessionIdentity, now: Date): void {
  const hash = hashResponseId(responseId);
  const expiresAt = new Date(now.getTime() + AFFINITY_TTL_MS);
  tx.insert(sessionResponse)
    .values({
      responseIdSha256: hash,
      sessionSource: identity.source,
      sessionId: identity.id,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: sessionResponse.responseIdSha256,
      set: { sessionSource: identity.source, sessionId: identity.id, expiresAt },
    })
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
  tx.delete(sessionResponse)
    .where(sql`${sessionResponse.expiresAt} <= ${cutoff.getTime()}`)
    .run();
}
