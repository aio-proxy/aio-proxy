import { createHash } from 'node:crypto';

/** The little-endian bytes of 0x6169_6f70_7278_7964 ("aioprxyd" read big-endian; the bytes spell "dyxrpoia"); the updater verifies against this key id. */
export const KEY_ID = Uint8Array.from(Buffer.from('64797872706f6961', 'hex'));

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const UNTRUSTED_COMMENT = 'untrusted comment: signature from aio-proxy-desktop key';
const PUBKEY_COMMENT = 'untrusted comment: aio-proxy-desktop update key';

const seedOf = (privateKey: string): Buffer => {
  const raw = Buffer.from(privateKey.trim(), 'base64');
  if (raw.length !== 32 && raw.length !== 64) throw new Error('SPARKLE_ED_PRIVATE_KEY is not a base64 Ed25519 key');
  return raw.subarray(0, 32);
};

const importPrivate = (privateKey: string, extractable: boolean) =>
  crypto.subtle.importKey('pkcs8', Buffer.concat([PKCS8_ED25519_PREFIX, seedOf(privateKey)]), 'Ed25519', extractable, [
    'sign',
  ]);

/**
 * The base64 public key for Sparkle's private key file (the base64 Ed25519 seed; a 64-byte
 * seed-then-public form is accepted). Lets publish check the key pair before anything irreversible.
 */
export async function publicKeyFromPrivate(privateKey: string): Promise<string> {
  const { x } = await crypto.subtle.exportKey('jwk', await importPrivate(privateKey, true));
  if (x === undefined) throw new Error('SPARKLE_ED_PRIVATE_KEY is not a base64 Ed25519 key');
  return Buffer.from(x, 'base64url').toString('base64');
}

/** Minisign public key text: a comment line, then base64("Ed" || key id || public key). */
export function minisignPublicKey(publicKeyBase64: string): string {
  const body = Buffer.concat([Buffer.from('Ed'), KEY_ID, Buffer.from(publicKeyBase64, 'base64')]);
  return `${PUBKEY_COMMENT}\n${body.toString('base64')}\n`;
}

/**
 * Minisign signature text in prehashed (`ED`) form: Ed25519 over the BLAKE2b-512 of the file, plus a
 * global signature over (signature || trusted comment). Ed25519 is deterministic, so a resumed
 * publish re-derives the same text.
 */
export async function signMinisign(file: Uint8Array, privateKey: string, trustedComment: string): Promise<string> {
  // The comment is one line of the four-line format.
  if (/[\r\n]/u.test(trustedComment)) throw new Error('a trusted comment cannot contain a line break');
  const key = await importPrivate(privateKey, false);
  const digest = createHash('blake2b512').update(file).digest();
  const sig = Buffer.from(await crypto.subtle.sign('Ed25519', key, digest));
  const globalSig = Buffer.from(
    await crypto.subtle.sign('Ed25519', key, Buffer.concat([sig, Buffer.from(trustedComment)])),
  );
  const line = Buffer.concat([Buffer.from('ED'), KEY_ID, sig]).toString('base64');
  return `${UNTRUSTED_COMMENT}\n${line}\ntrusted comment: ${trustedComment}\n${globalSig.toString('base64')}\n`;
}

/** The value the updater is configured with: base64 of the two-line public key text. */
export const updaterPubkey = (publicKeyBase64: string): string =>
  Buffer.from(minisignPublicKey(publicKeyBase64)).toString('base64');

/** The signature field the feed carries: base64 of the four-line .minisig text. */
export const updaterSignature = (minisig: string): string => Buffer.from(minisig).toString('base64');
