import { expect, test } from 'bun:test';

import { assertConnectResult } from './protocol';

test('rejects a native helper with an unsupported protocol version', () => {
  expect(() =>
    assertConnectResult({ identityId: 'id', spaceId: 'space', maxValueBytes: 1024, protocol: 2, version: '2.0.0' }),
  ).toThrow('invalid native connect result');
});
