import { expect, test } from 'bun:test';

import { SyncBackendError } from '@aio-proxy/plugin-sdk';

import { assertConnectResult, NativeSessionError } from './protocol';

test('rejects a native helper with an unsupported protocol version', () => {
  expect(() =>
    assertConnectResult({ identityId: 'id', spaceId: 'space', maxValueBytes: 1024, protocol: 2, version: '2.0.0' }),
  ).toThrow('invalid native connect result');
});

// Core gates backoff and the outcome-unknown reread branches on `instanceof`, not on
// the error name, so a name-only lookalike silently loses those semantics.
test('native failures satisfy the core SyncBackendError checks', () => {
  const error = new NativeSessionError('outcome-unknown');

  expect(error instanceof SyncBackendError).toBe(true);
  expect(error.code).toBe('outcome-unknown');
  expect(error.name).toBe('SyncBackendError');
});
