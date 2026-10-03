// Regenerates the Rust-side verification fixture with a throwaway key (never the release key):
//   bun desktop/scripts/minisign/update-fixture.ts
// `bun test` files cannot run as plain scripts, hence a separate entry point.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { publicKeyFromPrivate, signMinisign } from './minisign';

const dir = join(import.meta.dir, '../../src/platform/update_key/fixture');
const seed = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
const payload = crypto.getRandomValues(new Uint8Array(64));
writeFileSync(join(dir, 'payload.bin'), payload);
writeFileSync(
  join(dir, 'payload.bin.minisig'),
  await signMinisign(payload, seed, 'aio-proxy-desktop 9.9.9 linux-x86_64 payload.bin'),
);
writeFileSync(join(dir, 'pubkey.txt'), `${await publicKeyFromPrivate(seed)}\n`);
