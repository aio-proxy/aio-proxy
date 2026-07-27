import { describe, expect, test } from 'bun:test';

import type { SessionResponseResolution, TraceCompletion } from '@aio-proxy/core/db';

import { LogicalSessionStore, type LogicalSessionResolution, type SessionIdentity } from '../../logical-session-store';
import type { ServerLog } from '../../server-log';
import { createRequestTraceRecorder, type RequestTraceWriteStore } from './request-trace-recorder';

const IDENTITY_A: SessionIdentity = { source: 'body-session', id: 'session-a' };
const IDENTITY_B: SessionIdentity = { source: 'body-session', id: 'session-b' };

describe('response persistence confirmation', () => {
  test('confirms a normally persisted response without a client lookup so TTL resumes', () => {
    let now = new Date('2026-07-24T10:00:00.000Z');
    let persisted: SessionResponseResolution | undefined;
    const logical = logicalStore(
      () => now,
      () => persisted,
    );
    logical.commitResponse('resp-1', 'sha256:session-a', IDENTITY_A, 'provider-a');
    const recorder = createRequestTraceRecorder({
      store: writeStore((completion) => {
        persisted = owner(IDENTITY_A, 'provider-a');
        return completion.sessionState?.responseId === 'resp-1';
      }),
      onResponsePersisted: (responseId) => logical.reconcilePersistedResponse(responseId),
    });

    finishResponse(recorder, resolution(IDENTITY_A), 'resp-1', 'provider-a');
    persisted = undefined;
    now = new Date('2026-07-24T10:00:01.000Z');

    expect(resolve(logical, 'resp-1').responseStatus).toBe('none');
  });

  test('promotes the memory entry when terminal persistence records a collision', () => {
    let persisted: SessionResponseResolution | undefined = owner(IDENTITY_A, 'provider-a');
    const logical = logicalStore(
      () => new Date('2026-07-24T10:00:00.000Z'),
      () => persisted,
    );
    logical.commitResponse('resp-1', 'sha256:session-b', IDENTITY_B, 'provider-b');
    const recorder = createRequestTraceRecorder({
      store: writeStore(() => {
        persisted = { status: 'ambiguous' };
        return true;
      }),
      onResponsePersisted: (responseId) => logical.reconcilePersistedResponse(responseId),
    });

    finishResponse(recorder, resolution(IDENTITY_B), 'resp-1', 'provider-b');
    persisted = undefined;

    expect(resolve(logical, 'resp-1').responseStatus).toBe('ambiguous');
  });

  test('does not notify response persistence when completion returns false or throws', () => {
    const notified: string[] = [];
    const completions: readonly ((completion: TraceCompletion) => boolean)[] = [
      () => false,
      () => {
        throw new Error('db down');
      },
    ];

    for (const [index, complete] of completions.entries()) {
      const recorder = createRequestTraceRecorder({
        store: writeStore(complete),
        onResponsePersisted: (responseId) => notified.push(responseId),
      });
      finishResponse(recorder, resolution(IDENTITY_A), `resp-${index}`, 'provider-a');
    }

    expect(notified).toEqual([]);
  });

  test('contains and logs a response persistence callback failure', () => {
    const logs: ServerLog[] = [];
    const recorder = createRequestTraceRecorder({
      store: writeStore(() => true),
      logger: (entry) => void logs.push(entry),
      onResponsePersisted: () => {
        throw new Error('reconcile failed');
      },
    });

    expect(() => finishResponse(recorder, resolution(IDENTITY_A), 'resp-1', 'provider-a')).not.toThrow();
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'trace.persistence_failed', operation: 'response_reconcile' }),
    );
  });
});

function logicalStore(
  now: () => Date,
  resolveResponse: () => SessionResponseResolution | undefined,
): LogicalSessionStore {
  return new LogicalSessionStore({
    now,
    ttlMs: 100,
    repository: { resolveResponse, findAffinity: () => undefined },
  });
}

function writeStore(complete: (completion: TraceCompletion) => boolean): RequestTraceWriteStore {
  return { startRoot: () => {}, complete, prune: () => {}, recover: () => {} };
}

function finishResponse(
  recorder: ReturnType<typeof createRequestTraceRecorder>,
  sessionResolution: LogicalSessionResolution,
  responseId: string,
  providerId: string,
): void {
  const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-response' });
  session.identify({ requestedModelId: 'model-a', resolution: sessionResolution, mutateSessionState: true });
  session.finish({ outcome: 'success', responseId, finalProviderId: providerId, finalModelId: 'model-a' });
}

function resolution(identity: SessionIdentity): LogicalSessionResolution {
  const session = { key: `sha256:${identity.id}` as const, source: identity.source };
  return {
    requestId: 'request-a',
    session,
    context: { requestId: 'request-a', session },
    identity,
    resolvedBy: identity.source,
    responseStatus: 'none',
  };
}

function owner(identity: SessionIdentity, providerId: string): SessionResponseResolution {
  return { status: 'owned', owner: { identity, providerId } };
}

function resolve(store: LogicalSessionStore, previousResponseId: string): LogicalSessionResolution {
  return store.begin({
    requestId: 'request-a',
    requestedModelId: 'model-a',
    hints: { candidates: [], previousResponseId, transcript: {} },
    headers: new Headers(),
  });
}
