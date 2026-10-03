// Regenerates the Rust-side verification fixture with a throwaway key (never the release key):
//   bun desktop/scripts/minisign/update-fixture.ts
// `bun test` files cannot run as plain scripts, hence a separate entry point.
import { writeFileSync } from 'node:fs';

import { publicKeyFromPrivate, signMinisign } from './minisign';

const dir = new URL('../../src/platform/update_key/fixture/', import.meta.url).pathname;
const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const payload = crypto.getRandomValues(new Uint8Array(64));
writeFileSync(`${dir}payload.bin`, payload);
writeFileSync(
  `${dir}payload.bin.minisig`,
  await signMinisign(payload, seed, 'aio-proxy-desktop 9.9.9 linux-x86_64 payload.bin'),
);
writeFileSync(`${dir}pubkey.txt`, `${await publicKeyFromPrivate(seed)}\n`);
