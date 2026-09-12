export {
  canActivateSyncedAccount,
  decodeAccount,
  retainsSharedOAuth,
  type AccountPayload,
  type AccountRecord,
  type LiveAccount,
  type OAuthOwnership,
  type RefreshClaim,
  SyncOAuthError,
} from './protocol';
export { evaluateOAuthEvidence, type OAuthSyncEvidence } from './adapter-conformance';
export {
  createSharedOAuthCoordinator,
  type ExchangeResult,
  type SharedOAuthCoordinator,
  type SharedOAuthCoordinatorInput,
  type SharedRefreshInput,
  type SharedRefreshResult,
} from './coordinator';
export { applySyncedAccount } from './account-import';
export {
  createOAuthProviderGate,
  type OAuthProviderGate,
  PROVIDER_GATE_BUSY,
  createOAuthSharingService,
  type OAuthSharingService,
  type OAuthSharingServiceInput,
} from './sharing';
