import { expect, test } from 'bun:test';

import { CursorSessionStore, sessionKey } from './session-store';

test('round-trips a session and isolates identity scopes', () => {
  const store = new CursorSessionStore();
  const a = sessionKey({ identityScope: 'user-a', logicalSessionKey: 's1' });
  const b = sessionKey({ identityScope: 'user-b', logicalSessionKey: 's1' });
  store.set(a, {
    conversationId: 'conv-a',
    blobs: new Map(),
    checkpointUsable: true,
    pendingToolCalls: new Map(),
  });
  expect(store.get(a)?.conversationId).toBe('conv-a');
  expect(store.get(b)).toBeUndefined();
});

test('evicts the oldest entry past max', () => {
  const store = new CursorSessionStore({ max: 1 });
  store.set('k1', {
    conversationId: 'c1',
    blobs: new Map(),
    checkpointUsable: true,
    pendingToolCalls: new Map(),
  });
  store.set('k2', {
    conversationId: 'c2',
    blobs: new Map(),
    checkpointUsable: true,
    pendingToolCalls: new Map(),
  });
  expect(store.get('k1')).toBeUndefined();
  expect(store.get('k2')?.conversationId).toBe('c2');
});

test('bounds total retained bytes and drops an oversized same-key replacement', () => {
  const store = new CursorSessionStore({ maxSize: 20 });
  store.set('first', {
    conversationId: 'c',
    conversationState: new Uint8Array(2),
    blobs: new Map([['blob', new Uint8Array(4)]]),
    checkpointUsable: true,
    pendingToolCalls: new Map(),
  });
  store.set('next', {
    conversationId: 'c',
    blobs: new Map(),
    checkpointUsable: true,
    pendingToolCalls: new Map(),
  });

  expect(store.get('first')).toBeUndefined();
  expect(store.get('next')).toBeDefined();

  store.set('next', {
    conversationId: 'c',
    blobs: new Map(),
    checkpointUsable: true,
    pendingToolCalls: new Map([['outer-id', 'nested-id']]),
  });

  expect(store.get('next')).toBeUndefined();
});
