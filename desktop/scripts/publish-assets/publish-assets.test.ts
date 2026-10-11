import { expect, test } from 'bun:test';

import { publicKeyFromPrivate, signMinisign } from '../minisign';
import { assetStep, verifyPair } from './publish-assets';

const key = Buffer.alloc(32, 9).toString('base64');
const pub = await publicKeyFromPrivate(key);
const comment = 'aio-proxy-desktop 0.40.0 linux-x86_64 aio-proxy-0.40.0-x86_64.AppImage';
const firstBuild = new TextEncoder().encode('first build');
const rebuild = new TextEncoder().encode('second build');

test('each partial state has exactly one resume step, and none signs published bytes', () => {
  expect(assetStep({ asset: false, minisig: false })).toBe('sign-and-upload');
  expect(assetStep({ asset: false, minisig: true })).toBe('upload-verified-asset');
  expect(assetStep({ asset: true, minisig: true })).toBe('verify');
  expect(() => assetStep({ asset: true, minisig: false })).toThrow();
});

test('a rebuilt asset does not verify against the orphan signature of an earlier build', async () => {
  const minisig = await signMinisign(firstBuild, key, comment);
  expect(await verifyPair(firstBuild, minisig, pub, comment)).toBe(true);
  expect(await verifyPair(rebuild, minisig, pub, comment)).toBe(false);
});

test('a pair whose trusted comment names another version fails verification', async () => {
  const bytes = firstBuild;
  const minisig = await signMinisign(bytes, key, 'aio-proxy-desktop 0.39.0 linux-x86_64 a.AppImage');
  expect(await verifyPair(bytes, minisig, pub, 'aio-proxy-desktop 0.40.0 linux-x86_64 a.AppImage')).toBe(false);
});

test('another key, an edited trusted comment or malformed text fails without throwing', async () => {
  const minisig = await signMinisign(firstBuild, key, comment);
  const other = await publicKeyFromPrivate(Buffer.alloc(32, 3).toString('base64'));
  expect(await verifyPair(firstBuild, minisig, other, comment)).toBe(false);
  // The trusted comment line is only covered by the global signature.
  const edited = minisig.replace(comment, `${comment}x`);
  expect(await verifyPair(firstBuild, edited, pub, `${comment}x`)).toBe(false);
  for (const text of ['', 'not a signature', minisig.split('\n').slice(0, 2).join('\n')]) {
    expect(await verifyPair(firstBuild, text, pub, comment)).toBe(false);
  }
  expect(await verifyPair(firstBuild, minisig, 'bad key', comment)).toBe(false);
});
