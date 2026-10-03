import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { KEY_ID, publicKeyFromPrivate, signMinisign, updaterPubkey, updaterSignature } from './minisign';

test('minisign text verifies with WebCrypto for both Sparkle key forms', async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pub = await publicKeyFromPrivate(Buffer.from(seed).toString('base64'));
  const file = new TextEncoder().encode('payload');
  for (const priv of [seed, Buffer.concat([seed, Buffer.from(pub, 'base64')])]) {
    const text = await signMinisign(
      file,
      Buffer.from(priv).toString('base64'),
      'aio-proxy-desktop 0.40.0 linux-x86_64 a.AppImage',
    );
    const [untrusted = '', sigLine = '', trusted = '', globalLine = ''] = text.trimEnd().split('\n');
    expect(untrusted.startsWith('untrusted comment: ')).toBe(true);
    const sig = Buffer.from(sigLine, 'base64');
    expect(sig.subarray(0, 2).toString()).toBe('ED');
    expect(sig.subarray(2, 10)).toEqual(Buffer.from(KEY_ID));
    const key = await crypto.subtle.importKey('raw', Buffer.from(pub, 'base64'), 'Ed25519', false, ['verify']);
    const digest = createHash('blake2b512').update(file).digest();
    expect(await crypto.subtle.verify('Ed25519', key, sig.subarray(10), digest)).toBe(true);
    const comment = trusted.slice('trusted comment: '.length);
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        key,
        Buffer.from(globalLine, 'base64'),
        Buffer.concat([sig.subarray(10), Buffer.from(comment)]),
      ),
    ).toBe(true);
  }
});

test('signing is deterministic, so a resumed publish re-derives the same signature', async () => {
  const k = Buffer.alloc(32, 7).toString('base64');
  const f = new Uint8Array([1, 2, 3]);
  expect(await signMinisign(f, k, 'c')).toBe(await signMinisign(f, k, 'c'));
});

test('the updater strings wrap the minisign texts in one more base64 layer', async () => {
  const pub = await publicKeyFromPrivate(Buffer.alloc(32, 7).toString('base64'));
  const [comment = '', body = ''] = Buffer.from(updaterPubkey(pub), 'base64').toString().trimEnd().split('\n');
  expect(comment).toBe('untrusted comment: aio-proxy-desktop update key');
  expect(Buffer.from(body, 'base64').subarray(10)).toEqual(Buffer.from(pub, 'base64'));
  const text = await signMinisign(new Uint8Array([1]), Buffer.alloc(32, 7).toString('base64'), 'c');
  expect(Buffer.from(updaterSignature(text), 'base64').toString()).toBe(text);
});
