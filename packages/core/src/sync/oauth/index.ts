export {
  canActivateSyncedAccount,
  decodeAccount,
  type AccountPayload,
  type AccountRecord,
  type LiveAccount,
  type OAuthOwnership,
  type RefreshClaim,
  SyncOAuthError,
} from './protocol';
export {
  createSharedOAuthCoordinator,
  type ExchangeResult,
  type SharedOAuthCoordinator,
  type SharedOAuthCoordinatorInput,
  type SharedRefreshInput,
  type SharedRefreshResult,
} from './coordinator';
export { applySyncedAccount } from './account-import';
