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

test('derives a stable sub-based fingerprint and normalizes email', () => {
  const identity = cursorIdentity({ accessToken: jwt({ sub: 'user-1', email: 'A@B.com' }) });
  expect(identity.fingerprint.startsWith('sha256:')).toBe(true);
  expect(identity.suggestedKey).toBe(`cursor-${identity.fingerprint.slice('sha256:'.length, 'sha256:'.length + 12)}`);
  expect(identity.email).toBe('a@b.com');
});

test('rejects a token without a stable account identifier', () => {
  expect(() => cursorIdentity({ accessToken: jwt({}) })).toThrow(/stable account identifier/i);
});

test('uses normalized JWT email as the Cursor account label', () => {
  const identity = cursorIdentity({ accessToken: jwt({ sub: 'user-1', email: 'A@B.com' }) });
  expect(identity.label).toBe('a@b.com');
});

test('falls back to Cursor when the JWT has a subject but no email', () => {
  expect(cursorIdentity({ accessToken: jwt({ sub: 'user-1' }) }).label).toBe('Cursor');
});
