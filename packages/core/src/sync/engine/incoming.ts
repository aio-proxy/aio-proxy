import type { LocalCommitPort } from '../local-commit';
import type { EntityBody } from '../protocol';

export type PendingReason =
  | 'missing-plugin'
  | 'missing-env'
  | 'incompatible-version'
  | 'invalid-config'
  | 'invalid-credential'
  | 'provider-id-conflict'
  | 'oauth-unverified'
  | 'secret-conflict'
  | 'upgrade-required';

export interface ActivationResult {
  applied: boolean;
  pending?: PendingReason;
}

export interface LocalSyncPort extends LocalCommitPort {
  /** Check a desired remote body before mutating the running configuration. */
  checkRemote?(body: EntityBody, signal: AbortSignal): Promise<PendingReason | undefined>;
  /**
   * Applies an inbound body to the running configuration. A row the user has excluded is
   * acknowledged without being written, because a `sync leave` can complete while this pass is still
   * validating the body outside the mutation fence. `'reviewed'` marks the reviewed-decision path,
   * which imports into a row whose inclusion it records immediately afterwards, so the row is still
   * excluded when it writes.
   */
  applyRemote(
    objectId: string,
    body: EntityBody | null,
    operationId: string,
    intent?: 'reviewed',
  ): Promise<ActivationResult>;
}
