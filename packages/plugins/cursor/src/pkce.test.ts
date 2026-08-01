import { expect, test } from 'bun:test';

import { generateCursorPkce } from './pkce';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

test('produces a base64url verifier and a matching S256 challenge', async () => {
  const { verifier, challenge } = await generateCursorPkce();
  expect(verifier).toMatch(BASE64URL);
  expect(challenge).toMatch(BASE64URL);
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString(
    'base64url',
  );
  expect(challenge).toBe(expected);
});

test('produces unique verifiers', async () => {
  const [a, b] = await Promise.all([generateCursorPkce(), generateCursorPkce()]);
  expect(a.verifier).not.toBe(b.verifier);
});
