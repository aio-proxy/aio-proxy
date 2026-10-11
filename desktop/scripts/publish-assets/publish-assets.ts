import { createHash } from 'node:crypto';

import { KEY_ID } from '../minisign';

/** What a run does for one target, from what the version's Release already holds. */
export type AssetStep = 'sign-and-upload' | 'upload-verified-asset' | 'verify';

/**
 * Uploads go `.minisig` first, then the asset, so `.minisig` alone is an interrupted run. Only the empty
 * state signs: anything already published is verified, never re-signed.
 */
export function assetStep(present: { asset: boolean; minisig: boolean }): AssetStep {
  if (present.asset && !present.minisig) {
    throw new Error('the asset is published without its .minisig, which the upload order never leaves');
  }
  if (present.asset) return 'verify';
  return present.minisig ? 'upload-verified-asset' : 'sign-and-upload';
}

const UNTRUSTED_PREFIX = 'untrusted comment: ';
const TRUSTED_PREFIX = 'trusted comment: ';

/**
 * Checks a prehashed (`ED`) minisign text the way the desktop updater does: our key id, Ed25519 over the
 * file's BLAKE2b-512, the global signature over (signature || trusted comment), and the exact comment.
 * Any mismatch or malformed input is `false`.
 */
export async function verifyPair(
  bytes: Uint8Array,
  minisig: string,
  publicKey: string,
  expectedComment: string,
): Promise<boolean> {
  const [untrusted, sigLine, trusted, globalLine, ...rest] = minisig.trimEnd().split('\n');
  if (rest.length > 0 || untrusted?.startsWith(UNTRUSTED_PREFIX) !== true) return false;
  if (sigLine === undefined || globalLine === undefined || trusted !== `${TRUSTED_PREFIX}${expectedComment}`) {
    return false;
  }
  const sig = Buffer.from(sigLine, 'base64');
  const globalSig = Buffer.from(globalLine, 'base64');
  if (sig.length !== 74 || globalSig.length !== 64) return false;
  if (sig.subarray(0, 2).toString() !== 'ED' || !sig.subarray(2, 10).equals(KEY_ID)) return false;
  const signature = sig.subarray(10);
  try {
    const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64'), 'Ed25519', false, ['verify']);
    const digest = createHash('blake2b512').update(bytes).digest();
    return (
      (await crypto.subtle.verify('Ed25519', key, signature, digest)) &&
      (await crypto.subtle.verify('Ed25519', key, globalSig, Buffer.concat([signature, Buffer.from(expectedComment)])))
    );
  } catch {
    return false;
  }
}
