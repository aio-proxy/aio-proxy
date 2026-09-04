import { expect, test } from 'bun:test';

import { cursorSessionCookie, cursorUserId } from './cookie';

const token = (payload: object) => ['h', Buffer.from(JSON.stringify(payload)).toString('base64url'), 's'].join('.');

test('takes the last non-empty pipe segment of the sub claim', () => {
  expect(cursorUserId(token({ sub: 'auth0|user_01ABC' }))).toBe('user_01ABC');
  // `omittingEmptySubsequences` in the Swift source: a trailing pipe must not yield an empty id.
  expect(cursorUserId(token({ sub: 'auth0|user_01ABC|' }))).toBe('user_01ABC');
  expect(cursorUserId(token({ sub: 'user_01ABC' }))).toBe('user_01ABC');
});

// Credentials stored before `subject` existed still work, because the id comes from the live token.
test('prefers the live token claim and falls back to the stored subject', () => {
  expect(cursorUserId(token({ sub: 'auth0|from_token' }), 'auth0|from_storage')).toBe('from_token');
  expect(cursorUserId(token({}), 'auth0|from_storage')).toBe('from_storage');
});

test('rejects a subject the cursor.com cookie cannot carry', () => {
  expect(() => cursorUserId(token({ sub: 'auth0|user 01' }))).toThrow(/invalid account subject/i);
  expect(() => cursorUserId(token({}))).toThrow(/no account subject/i);
});

// A wrong separator or a wrong sub split is a silent 401 with no other symptom.
test('sends the percent-encoded separator verbatim', () => {
  const accessToken = token({ sub: 'auth0|user_01ABC' });
  expect(cursorSessionCookie(accessToken)).toBe(`WorkosCursorSessionToken=user_01ABC%3A%3A${accessToken}`);
});
