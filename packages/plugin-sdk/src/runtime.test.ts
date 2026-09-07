import { expect, test } from 'bun:test';

import { isRealtimeDialError, RealtimeDialError } from './runtime';

test('RealtimeDialError carries a discriminable kind and a stable name', () => {
  const error = new RealtimeDialError('upstream refused the handshake', { kind: 'rejected' });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('RealtimeDialError');
  expect(error.kind).toBe('rejected');
  expect(error.message).toBe('upstream refused the handshake');
});

// A plugin resolved from its own npm cache loads a second copy of this module, so the host's
// `instanceof` misses the error it throws and every dial failure degrades to `rejected`. The
// foreign copy is rebuilt here rather than imported twice because Bun dedupes a same-path
// import; what matters is that it shares only the registry symbol, not the constructor.
test('isRealtimeDialError recognizes an error thrown by a separate copy of the SDK', () => {
  class ForeignRealtimeDialError extends Error {
    override readonly name = 'RealtimeDialError';
    readonly [Symbol.for('@aio-proxy/plugin-sdk/realtime-dial-error/v1')] = true;
    readonly kind = 'timeout';
  }
  const foreign = new ForeignRealtimeDialError('dial deadline exceeded');

  expect(foreign).not.toBeInstanceOf(RealtimeDialError);
  expect(isRealtimeDialError(foreign)).toBe(true);
  expect(isRealtimeDialError(new RealtimeDialError('refused', { kind: 'rejected' }))).toBe(true);
  // A plain error and a non-error carrying the same shape must not pass: the host reads `kind`
  // straight off whatever this admits.
  expect(isRealtimeDialError(new Error('unrelated'))).toBe(false);
  expect(isRealtimeDialError({ [Symbol.for('@aio-proxy/plugin-sdk/realtime-dial-error/v1')]: true })).toBe(false);
});
