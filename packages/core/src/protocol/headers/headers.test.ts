import { expect, test } from 'bun:test';

import { stripHopHeaders } from './headers';

test('stripHopHeaders drops headers describing the original body encoding and keeps the rest', () => {
  const headers = stripHopHeaders(
    new Headers({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': '128',
      'content-md5': 'Q2hlY2sgSW50ZWdyaXR5IQ==',
      digest: 'sha-256=deadbeef',
      'content-digest': 'sha-256=:deadbeef:',
    }),
  );

  expect(headers.get('content-encoding')).toBeNull();
  expect(headers.get('content-length')).toBeNull();
  expect(headers.get('content-md5')).toBeNull();
  expect(headers.get('digest')).toBeNull();
  expect(headers.get('content-digest')).toBeNull();
  expect(headers.get('authorization')).toBe('Bearer secret');
  expect(headers.get('content-type')).toBe('application/json');
});
