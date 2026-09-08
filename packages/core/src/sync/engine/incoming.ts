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
  applyRemote(objectId: string, body: EntityBody | null, operationId: string): Promise<ActivationResult>;
}
