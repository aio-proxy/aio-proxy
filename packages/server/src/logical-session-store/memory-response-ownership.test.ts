import { describe, expect, test } from 'bun:test';

import { LogicalSessionStore, type SessionIdentity, type SessionResponseResolution } from './logical-session-store';

const IDENTITY: SessionIdentity = { source: 'body-session', id: 'session-a' };

describe('in-memory response ownership', () => {
  test('returns the original session and Provider ID for the same owner', () => {
    const store = new LogicalSessionStore();
    store.commitResponse('resp-1', 'sha256:session-a', IDENTITY, 'provider-a');
    store.commitResponse('resp-1', 'sha256:session-a', IDENTITY, 'provider-a');

    const resolution = resolve(store, 'resp-1');

    expect(resolution.resolvedBy).toBe('previous-response');
    expect(resolution.identity).toEqual(IDENTITY);
    expect(resolution.context.session).toEqual({ key: 'sha256:session-a', source: 'body-session' });
    expect(resolution.responseStatus).toBe('owned');
    expect(resolution.responseOwner).toEqual({ identity: IDENTITY, providerId: 'provider-a' });
  });

  test('marks different owners ambiguous without returning either mapping', () => {
    const store = new LogicalSessionStore();
    store.commitResponse('resp-1', 'sha256:session-a', IDENTITY, 'provider-a');
    store.commitResponse('resp-1', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');

    const resolution = resolve(store, 'resp-1');

    expect(resolution.resolvedBy).toBe('generated');
    expect(resolution.identity).not.toEqual(IDENTITY);
    expect(resolution.identity).not.toEqual({ source: 'body-session', id: 'session-b' });
    expect(resolution.responseStatus).toBe('ambiguous');
    expect(resolution.responseOwner).toBeUndefined();
  });

  test('reconciles a stale persisted owner with a newer memory owner as ambiguous', () => {
    const store = new LogicalSessionStore({
      repository: {
        resolveResponse: () => ({
          status: 'owned',
          owner: { identity: IDENTITY, providerId: 'provider-a' },
        }),
        findAffinity: () => undefined,
      },
    });
    store.commitResponse('resp-1', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');

    const resolution = resolve(store, 'resp-1');

    expect(resolution.responseStatus).toBe('ambiguous');
    expect(resolution.responseOwner).toBeUndefined();
  });

  test('keeps an unreconciled cached owner through TTL until persistence can be compared', () => {
    let now = new Date('2026-07-24T10:00:00.000Z');
    const store = new LogicalSessionStore({
      now: () => now,
      ttlMs: 100,
      repository: {
        resolveResponse: () => ({
          status: 'owned',
          owner: { identity: IDENTITY, providerId: 'provider-a' },
        }),
        findAffinity: () => undefined,
      },
    });
    store.commitResponse('resp-1', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');
    now = new Date('2026-07-24T10:00:01.000Z');

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
  });

  test('keeps an unreconciled cached owner through capacity pressure until persistence can be compared', () => {
    let now = new Date('2026-07-24T10:00:00.000Z');
    const store = new LogicalSessionStore({
      now: () => now,
      maxEntries: 1,
      repository: {
        resolveResponse: () => ({
          status: 'owned',
          owner: { identity: IDENTITY, providerId: 'provider-a' },
        }),
        findAffinity: () => undefined,
      },
    });
    store.commitResponse('resp-1', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');
    now = new Date('2026-07-24T10:00:00.001Z');
    store.commitResponse('resp-2', 'sha256:session-c', { source: 'body-session', id: 'session-c' }, 'provider-c');

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
  });

  test('restores normal TTL after persistence confirms the cached owner', () => {
    let now = new Date('2026-07-24T10:00:00.000Z');
    let persisted = true;
    const store = new LogicalSessionStore({
      now: () => now,
      ttlMs: 100,
      repository: {
        resolveResponse: () =>
          persisted
            ? {
                status: 'owned',
                owner: { identity: IDENTITY, providerId: 'provider-a' },
              }
            : undefined,
        findAffinity: () => undefined,
      },
    });
    store.commitResponse('resp-1', 'sha256:session-a', IDENTITY, 'provider-a');
    expect(resolve(store, 'resp-1').responseStatus).toBe('owned');

    persisted = false;
    now = new Date('2026-07-24T10:00:01.000Z');

    expect(resolve(store, 'resp-1').responseStatus).toBe('none');
  });

  test('promotes a cross-source mismatch to a tombstone before owned-entry eviction', () => {
    const store = new LogicalSessionStore({
      maxEntries: 1,
      repository: {
        resolveResponse: () => ({
          status: 'owned',
          owner: { identity: IDENTITY, providerId: 'provider-a' },
        }),
        findAffinity: () => undefined,
      },
    });
    store.commitResponse('resp-1', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');
    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');

    store.commitResponse('resp-2', 'sha256:session-c', { source: 'body-session', id: 'session-c' }, 'provider-c');

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
  });

  test('remembers persisted ambiguity when the repository later becomes unavailable', () => {
    let available = true;
    const store = new LogicalSessionStore({
      repository: {
        resolveResponse: () => {
          if (!available) throw new Error('database unavailable');
          return { status: 'ambiguous' };
        },
        findAffinity: () => undefined,
      },
    });

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
    available = false;

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
  });

  test('repairs a persisted owner collision so a restarted store remains ambiguous', () => {
    let persisted: SessionResponseResolution = {
      status: 'owned' as const,
      owner: { identity: IDENTITY, providerId: 'provider-a' },
    };
    const repository = {
      resolveResponse: () => persisted,
      markResponseAmbiguous: () => {
        persisted = { status: 'ambiguous' };
      },
      findAffinity: () => undefined,
    };
    const store = new LogicalSessionStore({ repository });
    store.commitResponse('resp-1', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');

    expect(resolve(new LogicalSessionStore({ repository }), 'resp-1').responseStatus).toBe('ambiguous');
  });

  test('enters bounded fail-closed mode when unconfirmed entries exceed capacity', () => {
    const store = new LogicalSessionStore({ maxEntries: 1 });
    store.commitResponse('resp-1', 'sha256:session-a', IDENTITY, 'provider-a');
    store.commitResponse('resp-2', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
    expect(resolve(store, 'resp-2').responseStatus).toBe('ambiguous');
  });

  test('enters fail-closed mode when an unconfirmed owner reaches its TTL', () => {
    let now = new Date('2026-07-24T10:00:00.000Z');
    const store = new LogicalSessionStore({ now: () => now, ttlMs: 100 });
    store.commitResponse('resp-1', 'sha256:session-a', IDENTITY, 'provider-a');
    now = new Date('2026-07-24T10:00:01.000Z');

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
    expect(resolve(store, 'unknown-response').responseStatus).toBe('ambiguous');
  });

  test('keeps ambiguity fail-closed after the memory TTL expires', () => {
    let now = new Date('2026-07-24T10:00:00.000Z');
    const store = new LogicalSessionStore({ now: () => now, ttlMs: 100 });
    store.commitResponse('resp-1', 'sha256:session-a', IDENTITY, 'provider-a');
    store.commitResponse('resp-1', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');
    now = new Date('2026-07-24T10:00:01.000Z');

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
  });

  test('does not evict ambiguity tombstones to satisfy the owned-entry capacity', () => {
    let now = new Date('2026-07-24T10:00:00.000Z');
    const store = new LogicalSessionStore({ now: () => now, maxEntries: 1 });
    store.commitResponse('resp-1', 'sha256:session-a', IDENTITY, 'provider-a');
    now = new Date('2026-07-24T10:00:00.001Z');
    store.commitResponse('resp-1', 'sha256:session-b', { source: 'body-session', id: 'session-b' }, 'provider-b');
    now = new Date('2026-07-24T10:00:00.002Z');
    store.commitResponse('resp-2', 'sha256:session-c', { source: 'body-session', id: 'session-c' }, 'provider-c');

    expect(resolve(store, 'resp-1').responseStatus).toBe('ambiguous');
  });
});

function resolve(store: LogicalSessionStore, previousResponseId: string) {
  return store.begin({
    requestId: 'request-a',
    requestedModelId: 'model-a',
    hints: { candidates: [], previousResponseId, transcript: {} },
    headers: new Headers(),
  });
}
