import { describe, expect, test } from 'bun:test';

import {
  LogicalSessionStore,
  type LogicalSessionRepository,
  type SessionAffinityObservation,
  type SessionIdentity,
} from './logical-session-store';

describe('LogicalSessionStore', () => {
  test('uses internal, protocol, header, previous-response, then generated priority', () => {
    const store = new LogicalSessionStore({
      repository: stubRepository({ responses: new Map([['resp-1', { source: 'body-session', id: 'body' }]]) }),
    });
    const protocol = [{ source: 'body-session', value: 'body' }] as const;
    const input = {
      requestId: 'req',
      requestedModelId: 'gpt',
      hints: { candidates: protocol, transcript: ['hello'] },
      headers: new Headers({ 'x-session-id': 'header' }),
    };

    expect(store.begin({ ...input, internalSessionId: 'internal' }).resolvedBy).toBe('internal');
    expect(store.begin(input).resolvedBy).toBe('body-session');
    expect(store.begin({ ...input, hints: { candidates: [], transcript: ['hello'] } }).resolvedBy).toBe(
      'header-session',
    );
    expect(
      store.begin({
        requestId: 'req',
        requestedModelId: 'gpt',
        hints: { candidates: [], previousResponseId: 'resp-1', transcript: ['next'] },
        headers: new Headers(),
      }).resolvedBy,
    ).toBe('previous-response');
    expect(
      store.begin({
        requestId: 'req',
        requestedModelId: 'gpt',
        hints: { candidates: [], transcript: ['hello'] },
        headers: new Headers(),
      }).resolvedBy,
    ).toBe('generated');
  });

  test('builds context requestId from input and session key from identity', () => {
    const store = new LogicalSessionStore({ repository: stubRepository() });
    const resolution = store.begin({
      requestId: 'request-a',
      requestedModelId: 'gpt',
      hints: { candidates: [{ source: 'openai-prompt-cache', value: ' cache-key ' }], transcript: {} },
      headers: new Headers({ 'x-session-id': 'header-session' }),
    });

    expect(resolution).toMatchObject({
      identity: { source: 'openai-prompt-cache', id: 'cache-key' },
      resolvedBy: 'openai-prompt-cache',
      context: {
        requestId: 'request-a',
        session: { source: 'openai-prompt-cache' },
      },
    });
    expect(resolution.context.session.key).toMatch(/^sha256:/);
  });

  test('memory fallback returns the committed identity, not the hashed key', () => {
    // No repository -> resolveResponse is a no-op, so begin() must fall back to
    // the in-memory map. commitResponse now carries the real (source, id) so the
    // fallback resolves the same identity the persisted path would.
    const store = new LogicalSessionStore();
    store.commitResponse('resp-mem', 'sha256:deadbeef', { source: 'openai-prompt-cache', id: 'real-session' });

    const resolution = store.begin({
      requestId: 'req',
      requestedModelId: 'gpt',
      hints: { candidates: [], previousResponseId: 'resp-mem', transcript: {} },
      headers: new Headers(),
    });

    expect(resolution.resolvedBy).toBe('previous-response');
    expect(resolution.identity).toEqual({ source: 'openai-prompt-cache', id: 'real-session' });
    expect(resolution.context.session).toEqual({ key: 'sha256:deadbeef', source: 'openai-prompt-cache' });
  });

  test('resolves previous response through the repository with the original identity', () => {
    const repository = stubRepository({
      responses: new Map([['resp-older', { source: 'openai-prompt-cache', id: 'cache-key' }]]),
    });
    const store = new LogicalSessionStore({ repository });
    const resolution = store.begin({
      requestId: 'request-a',
      requestedModelId: 'gpt',
      hints: { candidates: [], previousResponseId: 'resp-older', transcript: {} },
      headers: new Headers(),
    });

    expect(resolution.resolvedBy).toBe('previous-response');
    expect(resolution.identity).toEqual({ source: 'openai-prompt-cache', id: 'cache-key' });
    expect(repository.lastResolveResponse).toBe('resp-older');
  });

  test('returns active affinity observation for a resolved session', () => {
    const affinity: SessionAffinityObservation = { providerId: 'p1', revision: 3, active: true };
    const repository = stubRepository({
      affinities: new Map([['openai-prompt-cache:cache-key:gpt', affinity]]),
    });
    const store = new LogicalSessionStore({ repository });
    const resolution = store.begin({
      requestId: 'request-a',
      requestedModelId: 'gpt',
      hints: { candidates: [{ source: 'openai-prompt-cache', value: 'cache-key' }], transcript: {} },
      headers: new Headers(),
    });

    expect(resolution.affinity).toEqual(affinity);
    expect(repository.lastFindAffinity).toEqual({
      identity: { source: 'openai-prompt-cache', id: 'cache-key' },
      requestedModelId: 'gpt',
    });
  });

  test('keeps expired affinity observation available for CAS with active false', () => {
    const affinity: SessionAffinityObservation = { providerId: 'p1', revision: 3, active: false };
    const repository = stubRepository({
      affinities: new Map([['openai-prompt-cache:cache-key:gpt', affinity]]),
    });
    const store = new LogicalSessionStore({ repository });
    const resolution = store.begin({
      requestId: 'request-a',
      requestedModelId: 'gpt',
      hints: { candidates: [{ source: 'openai-prompt-cache', value: 'cache-key' }], transcript: {} },
      headers: new Headers(),
    });

    expect(resolution.affinity).toEqual(affinity);
    expect(resolution.affinity?.active).toBe(false);
  });

  test('does not look up affinity for generated sessions', () => {
    const repository = stubRepository();
    const store = new LogicalSessionStore({ repository });
    store.begin({
      requestId: 'request-a',
      requestedModelId: 'gpt',
      hints: { candidates: [], transcript: ['hello'] },
      headers: new Headers(),
    });

    expect(repository.findAffinityCalls).toBe(0);
  });

  test('fails open when resolveResponse throws and emits a persistence log', () => {
    const events: unknown[] = [];
    const repository = stubRepository({ resolveError: new Error('boom') });
    const store = new LogicalSessionStore({ repository, logger: (entry) => events.push(entry) });
    const resolution = store.begin({
      requestId: 'request-a',
      requestedModelId: 'gpt',
      hints: { candidates: [], previousResponseId: 'resp-1', transcript: {} },
      headers: new Headers(),
    });

    expect(resolution.resolvedBy).toBe('generated');
    expect(events).toEqual([
      expect.objectContaining({
        event: 'trace.persistence_failed',
        operation: 'resolve_response',
        requestId: 'request-a',
      }),
    ]);
  });

  test('fails open when findAffinity throws and emits a persistence log', () => {
    const events: unknown[] = [];
    const repository = stubRepository({
      affinities: new Map([['body-session:body:gpt', { providerId: 'p1', revision: 1, active: true }]]),
      affinityError: new Error('boom'),
    });
    const store = new LogicalSessionStore({ repository, logger: (entry) => events.push(entry) });
    const resolution = store.begin({
      requestId: 'request-a',
      requestedModelId: 'gpt',
      hints: { candidates: [{ source: 'body-session', value: 'body' }], transcript: {} },
      headers: new Headers(),
    });

    expect(resolution.resolvedBy).toBe('body-session');
    expect(resolution.affinity).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({
        event: 'trace.persistence_failed',
        operation: 'find_affinity',
        requestId: 'request-a',
      }),
    ]);
  });
});

type StubRepositoryOptions = {
  readonly responses?: Map<string, SessionIdentity>;
  readonly affinities?: Map<string, SessionAffinityObservation>;
  readonly resolveError?: Error;
  readonly affinityError?: Error;
};

function stubRepository(options: StubRepositoryOptions = {}): LogicalSessionRepository & {
  readonly lastResolveResponse: string | undefined;
  readonly lastFindAffinity: { identity: SessionIdentity; requestedModelId: string } | undefined;
  readonly findAffinityCalls: number;
} {
  const responses = options.responses ?? new Map<string, SessionIdentity>();
  const affinities = options.affinities ?? new Map<string, SessionAffinityObservation>();
  let lastResolveResponse: string | undefined;
  let lastFindAffinity: { identity: SessionIdentity; requestedModelId: string } | undefined;
  let findAffinityCalls = 0;
  return {
    get lastResolveResponse() {
      return lastResolveResponse;
    },
    get lastFindAffinity() {
      return lastFindAffinity;
    },
    get findAffinityCalls() {
      return findAffinityCalls;
    },
    resolveResponse(responseId, _now) {
      lastResolveResponse = responseId;
      if (options.resolveError !== undefined) throw options.resolveError;
      return responses.get(responseId);
    },
    findAffinity(identity, requestedModelId, _now) {
      findAffinityCalls += 1;
      lastFindAffinity = { identity, requestedModelId };
      if (options.affinityError !== undefined) throw options.affinityError;
      return affinities.get(`${identity.source}:${identity.id}:${requestedModelId}`);
    },
  };
}
