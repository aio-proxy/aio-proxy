import type {
  CommittedSource,
  LocalBinding,
  LocalEntity,
  PluginRegistry,
  PluginRepository,
  SyncRepository,
} from '@aio-proxy/core';
import type { JsonValue, SyncSession } from '@aio-proxy/plugin-sdk';
import type { SyncPreviewInput } from '@aio-proxy/types';

import type { ServerSyncLifecycle } from '../lifecycle';
import { SyncOperationError, type OperationInput } from '../operations';
import { listRemoteEntities, type RemoteEntity } from '../preview';
import type { SyncConnectCandidate } from '../preview-store';
import { createRemoteOperations } from '../remote-operations';

export type SyncControlPlaneOptions = {
  readonly repo: SyncRepository;
  readonly registry?: () => PluginRegistry;
  readonly accounts?: PluginRepository;
  readonly backendOptions?: (plugin: string, capability: string) => JsonValue | undefined;
  readonly binding?: () => LocalBinding | null;
  readonly localEntities?: () => readonly LocalEntity[];
  /** The committed configuration a join projects local-only bodies from. */
  readonly committedSource?: () => Promise<CommittedSource>;
  readonly session?: () => SyncSession | undefined;
  /**
   * The mutation fence `applyRemote` holds. Excluding a Provider outside it can land between the
   * entity snapshot that call takes and the row it writes back, silently re-including the Provider.
   */
  readonly withFence?: <T>(run: () => Promise<T>) => Promise<T>;
  readonly remoteEntities?: () => Promise<readonly RemoteEntity[]>;
  readonly lifecycle?: Partial<Pick<ServerSyncLifecycle, 'start'>> &
    Pick<ServerSyncLifecycle, 'activate' | 'reconcile' | 'close'>;
  readonly applyLocal: OperationInput['applyLocal'];
  readonly applyCloud?: OperationInput['applyCloud'];
  readonly restore?: OperationInput['restore'];
  readonly persistOverrides: OperationInput['persistOverrides'];
  readonly persistProviderIdentity?: OperationInput['persistProviderIdentity'];
  readonly shareOAuth?: OperationInput['shareOAuth'];
  readonly connect: (input: Extract<SyncPreviewInput, { kind: 'connect' }>) => Promise<SyncConnectCandidate>;
  readonly detach?: (providerId: string, loginSessionId?: string) => Promise<void>;
  readonly cancelDetach?: (providerId: string) => Promise<void>;
  readonly purge?: OperationInput['purge'];
  /**
   * Registers the sink the lifecycle pushes background engine outcomes into. Without it the public
   * state only ever moves on a manual preview/apply/retry, so automatic synchronization can be
   * failing while the Dashboard and CLI still report `idle`.
   */
  readonly onEngineStatus?: (handle: (status: string) => void) => void;
  readonly now?: () => number;
  /** How long a preview stays applicable before it is discarded. Defaults to ten minutes. */
  readonly previewTtlMs?: number;
  readonly randomBytes?: (size: number) => Uint8Array;
};

export type ResolvedOptions = {
  readonly now: () => number;
  readonly previewTtlMs: number;
  readonly binding: () => LocalBinding | null;
  readonly localEntities: () => readonly LocalEntity[];
  readonly remoteEntities: () => Promise<readonly RemoteEntity[]>;
  readonly restore: OperationInput['restore'];
  readonly purge: OperationInput['purge'];
  readonly applyCloud: OperationInput['applyCloud'];
};

/**
 * Fills in what the caller left out and rejects a backend that can supply neither a session nor the
 * operations it would stand in for. `signal` is read per call rather than captured: disconnect
 * aborts the lifetime and re-arms a fresh controller, and this control plane outlives that cycle.
 */
export function resolveOptions(options: SyncControlPlaneOptions, signal: () => AbortSignal): ResolvedOptions {
  if (
    options.applyLocal === undefined ||
    (options.applyCloud === undefined && options.session === undefined) ||
    (options.restore === undefined && options.session === undefined) ||
    options.persistOverrides === undefined ||
    (options.purge === undefined && options.session === undefined) ||
    options.connect === undefined
  )
    throw new SyncOperationError('backend-unavailable');
  const binding = options.binding ?? (() => options.repo.readBinding());
  // Reads against the bound session outlive nothing but the binding, so a stalled `list`/`read`
  // after network loss would otherwise hang until the process exits.
  const remoteOps = (): ReturnType<typeof createRemoteOperations> =>
    createRemoteOperations(options.session!(), signal());
  return {
    now: options.now ?? Date.now,
    previewTtlMs: options.previewTtlMs ?? 10 * 60_000,
    binding,
    localEntities:
      options.localEntities ??
      (() => {
        const current = binding();
        return current === null ? [] : options.repo.entities(current.id);
      }),
    remoteEntities: options.remoteEntities ?? (() => listRemoteEntities(options.session?.(), signal())),
    restore: options.restore ?? ((...args) => remoteOps().restore(...args)),
    purge: options.purge ?? ((...args) => remoteOps().purge(...args)),
    applyCloud: options.applyCloud ?? ((...args) => remoteOps().publish(...args)),
  };
}
