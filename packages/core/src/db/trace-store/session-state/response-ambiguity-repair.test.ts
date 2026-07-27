import { describe, expect, test } from 'bun:test';

import { hashSession } from '../../../protocol/session';
import { sessionResponse } from '../../schema';
import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';

const NOW = new Date('2026-07-24T10:00:00.000Z');

describe('response ambiguity repair', () => {
  test('persists a tombstone when no response owner row exists', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);

      markAmbiguous(store, 'resp-missing');

      const row = handle.db.select().from(sessionResponse).get();
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        responseIdSha256: hashSession('response-id', 'resp-missing'),
        sessionSource: null,
        sessionId: null,
        providerId: null,
        ambiguous: true,
      });
      expect(store.resolveResponse('resp-missing', NOW)).toEqual({ status: 'ambiguous' });
    } finally {
      handle.close();
    }
  });

  test('promotes an existing response owner to a tombstone', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      handle.db
        .insert(sessionResponse)
        .values({
          responseIdSha256: hashSession('response-id', 'resp-owned'),
          sessionSource: 'body-session',
          sessionId: 'session-a',
          providerId: 'provider-a',
          ambiguous: false,
          expiresAt: new Date(NOW.getTime() + 60_000),
        })
        .run();

      markAmbiguous(store, 'resp-owned');

      expect(handle.db.select().from(sessionResponse).get()).toMatchObject({
        sessionSource: 'body-session',
        sessionId: 'session-a',
        providerId: 'provider-a',
        ambiguous: true,
      });
      expect(store.resolveResponse('resp-owned', NOW)).toEqual({ status: 'ambiguous' });
    } finally {
      handle.close();
    }
  });
});

function markAmbiguous(store: ReturnType<typeof createTraceStore>, responseId: string): void {
  const repair = Reflect.get(store, 'markResponseAmbiguous');
  if (typeof repair === 'function') repair(responseId, NOW);
}
