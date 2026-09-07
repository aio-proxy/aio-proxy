import { expect, test } from 'bun:test';

import { generatePKCE } from './pkce';

test('generates an S256 verifier and challenge pair', async () => {
  const first = await generatePKCE();
  const second = await generatePKCE();
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.verifier).not.toBe(first.challenge);
  expect(first.verifier).not.toBe(second.verifier);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(first.verifier));
  expect(first.challenge).toBe(new Uint8Array(digest).toBase64({ alphabet: 'base64url', omitPadding: true }));
});
