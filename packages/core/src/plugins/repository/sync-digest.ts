/**
 * A pending account operation for a synced credential carries its phase in the stored target
 * digest, because the provider-entry digest alone cannot say whether the credential ever reached
 * the backend. Publication happens only after the config rename, so an operation still `staged`
 * whose entry never landed is a plain interrupted write and compensates; once it is `published`
 * the backend may already hold the credential and the operation is retained until it reconciles
 * exactly.
 */
export const SYNC_STAGED_PREFIX = 'oauth-sync:';
export const SYNC_PUBLISHED_PREFIX = 'oauth-published:';

export type SyncDigestPhase = 'none' | 'staged' | 'published';

export function syncDigestPhase(targetDigest: string): {
  readonly phase: SyncDigestPhase;
  readonly digest: string;
} {
  if (targetDigest.startsWith(SYNC_STAGED_PREFIX))
    return { phase: 'staged', digest: targetDigest.slice(SYNC_STAGED_PREFIX.length) };
  if (targetDigest.startsWith(SYNC_PUBLISHED_PREFIX))
    return { phase: 'published', digest: targetDigest.slice(SYNC_PUBLISHED_PREFIX.length) };
  return { phase: 'none', digest: targetDigest };
}
