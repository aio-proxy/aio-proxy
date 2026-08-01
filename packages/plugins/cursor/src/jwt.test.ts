import { expect, test } from 'bun:test';

import { cursorIdentity, cursorTokenExpiry } from './jwt';

const jwt = (payload: object) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

test('applies a single 5-minute skew to the JWT exp', () => {
  const exp = 2_000_000; // seconds
  expect(cursorTokenExpiry(jwt({ exp }), 0)).toBe(exp * 1000 - 5 * 60_000);
});

test('falls back to now + 1 hour when exp is unparseable', () => {
  expect(cursorTokenExpiry('not.a.jwt', 1_000)).toBe(1_000 + 3_600_000);
  expect(cursorTokenExpiry(jwt({}), 1_000)).toBe(1_000 + 3_600_000);
});

test('derives a stable sub-based fingerprint independent of the refresh token', () => {
  const a = cursorIdentity({ accessToken: jwt({ sub: 'user-1', email: 'A@B.com' }), refreshToken: 'r1' });
  const b = cursorIdentity({ accessToken: jwt({ sub: 'user-1', email: 'A@B.com' }), refreshToken: 'r2-rotated' });
  expect(a.fingerprint).toBe(b.fingerprint);
  expect(a.fingerprint.startsWith('sha256:')).toBe(true);
  expect(a.suggestedKey).toBe(`cursor-${a.fingerprint.slice('sha256:'.length, 'sha256:'.length + 12)}`);
  expect(a.email).toBe('a@b.com');
});

test('falls back to the refresh token only when no sub or email exists', () => {
  const id = cursorIdentity({ accessToken: jwt({}), refreshToken: 'only-refresh' });
  const expected = new Bun.CryptoHasher('sha256').update('refresh:only-refresh').digest('hex');
  expect(id.fingerprint).toBe(`sha256:${expected}`);
  expect(id.label).toBe('Cursor');
});
