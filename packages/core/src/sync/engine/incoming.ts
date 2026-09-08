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
  | 'upgrade-required';

export interface ActivationResult {
  applied: boolean;
  pending?: PendingReason;
}

export interface LocalSyncPort extends LocalCommitPort {
  /** Check a desired remote body before mutating the running configuration. */
  checkRemote?(body: EntityBody): Promise<PendingReason | undefined>;
  applyRemote(objectId: string, body: EntityBody | null, operationId: string): Promise<ActivationResult>;
}
