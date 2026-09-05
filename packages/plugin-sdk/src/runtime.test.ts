import { expect, test } from 'bun:test';

import { RealtimeDialError } from './runtime';

test('RealtimeDialError carries a discriminable kind and a stable name', () => {
  const error = new RealtimeDialError('upstream refused the handshake', { kind: 'rejected' });

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('RealtimeDialError');
  expect(error.kind).toBe('rejected');
  expect(error.message).toBe('upstream refused the handshake');
});
