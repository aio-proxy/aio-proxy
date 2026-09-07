import { expect, test } from 'bun:test';

import { generatePKCE, generateState } from './pkce';

test('generates unique S256 PKCE and unpadded state', async () => {
  const first = await generatePKCE();
  const second = await generatePKCE();
  expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(first.verifier).not.toBe(second.verifier);
  expect(first.challenge).not.toBe(second.challenge);
  const digest = new Bun.CryptoHasher('sha256').update(first.verifier).digest();
  const expected = Buffer.from(digest).toString('base64url');
  expect(first.challenge).toBe(expected);
  const state = generateState();
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(state).not.toBe(generateState());
});
