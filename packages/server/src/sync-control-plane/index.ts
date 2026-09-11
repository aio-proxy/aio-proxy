export {
  activateDesired,
  checkPrerequisites,
  readOAuthActivationEvidence,
  type ActivationInput,
  type OAuthActivationEvidence,
} from './activation';
export { createLocalSyncPort, type LocalPortInput } from './local-port';
export { createServerSyncLifecycle, type ServerSyncLifecycle, type ServerSyncLifecycleInput } from './lifecycle';
export { createSyncControlPlane, type SyncConnectCandidate, type SyncControlPlaneOptions } from './control-plane';
export { rewireProviderReferences, SyncOperationError } from './operations';
export { listRemoteEntities, SyncPreviewError } from './preview';
