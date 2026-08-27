import { expect, test } from 'bun:test';

import { hasInvalidOrOversizedContentLength } from './request';

test('preflight uses adapter bodyLimits encoded, not the language 64 MiB constant', () => {
  const raw = new Request('https://x', {
    method: 'POST',
    headers: { 'content-length': String(65 * 1_024 * 1_024) },
    body: 'x',
  });
  expect(hasInvalidOrOversizedContentLength(raw, { encoded: 357_564_416, decoded: 357_564_416 })).toBe(false);
  expect(hasInvalidOrOversizedContentLength(raw, { encoded: 64 * 1_024 * 1_024, decoded: 128 * 1_024 * 1_024 })).toBe(
    true,
  );
});
