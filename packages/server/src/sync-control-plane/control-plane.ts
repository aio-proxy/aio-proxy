import {
  decodeHead,
  decodeRevision,
  entityKey,
  revisionKey,
  type CommittedSource,
  type EntityBody,
  type LocalBinding,
  type LocalEntity,
  type PluginRegistry,
  type PluginRepository,
  type SyncRepository,
} from '@aio-proxy/core';
import type { SyncSession } from '@aio-proxy/plugin-sdk';
import type {
  SyncApplyInput,
  SyncBackendView,
  SyncConnectionState,
  SyncControlPlane,
  SyncHistoryItem,
  SyncPreviewInput,
  SyncStatus,
} from '@aio-proxy/types';

import type { ServerSyncLifecycle } from './lifecycle';
import { applyPreview, setRange, SyncOperationError, type OperationInput } from './operations';
import {
  buildPreview,
  createPreviewToken,
  latestCommitId,
  listRemoteEntities,
  snapshotRemoteEntities,
  snapshotLocalEntities,
  SyncPreviewError,
  type PreviewFence,
  type PreviewRecord,
  type RemoteEntity,
} from './preview';
import { createRemoteOperations } from './remote-operations';
import { createStatus } from './status';

export type SyncControlPlaneOptions = {
  readonly repo: SyncRepository;
  readonly registry?: () => PluginRegistry;
  readonly accounts?: PluginRepository;
  readonly backendOptions?: (
    plugin: string,
    capability: string,
  ) => import('@aio-proxy/plugin-sdk').JsonValue | undefined;
  readonly binding?: () => LocalBinding | null;
  readonly localEntities?: () => readonly LocalEntity[];
  /** The committed configuration a join projects local-only bodies from. */
  readonly committedSource?: () => Promise<CommittedSource>;
  readonly session?: () => SyncSession | undefined;
  readonly remoteEntities?: () => Promise<readonly RemoteEntity[]>;
  readonly lifecycle?: Partial<Pick<ServerSyncLifecycle, 'start'>> &
    Pick<ServerSyncLifecycle, 'activate' | 'reconcile' | 'close'>;
  readonly applyLocal: OperationInput['applyLocal'];
  readonly applyCloud?: (
    candidate: EntityBody | null,
    current: LocalEntity | undefined,
    expectedVersion: string | null,
  ) => Promise<void>;
  readonly restore?: OperationInput['restore'];
  readonly persistOverrides: OperationInput['persistOverrides'];
  readonly persistProviderIdentity?: OperationInput['persistProviderIdentity'];
  readonly connect: (input: Extract<SyncPreviewInput, { kind: 'connect' }>) => Promise<void>;
  readonly detach?: (providerId: string, loginSessionId: string) => Promise<void>;
  readonly cancelDetach?: (providerId: string) => Promise<void>;
  readonly purge?: OperationInput['purge'];
  /**
   * Registers the sink the lifecycle pushes background engine outcomes into. Without it the public
   * state only ever moves on a manual preview/apply/retry, so automatic synchronization can be
   * failing while the Dashboard and CLI still report `idle`.
   */
  readonly onEngineStatus?: (handle: (status: string) => void) => void;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
};

const ENGINE_STATES: Readonly<Record<string, SyncConnectionState>> = {
  offline: 'offline',
  quota: 'quota',
  'identity-changed': 'identity-changed',
  error: 'error',
};

// eslint-disable-next-line max-lines-per-function -- this assembles the public operations over one fence owner
export function createSyncControlPlane(options: SyncControlPlaneOptions): SyncControlPlane {
  if (
    options.applyLocal === undefined ||
    (options.applyCloud === undefined && options.session === undefined) ||
    (options.restore === undefined && options.session === undefined) ||
    options.persistOverrides === undefined ||
    (options.purge === undefined && options.session === undefined) ||
    options.connect === undefined
  )
    throw new SyncOperationError('backend-unavailable');
  const now = options.now ?? Date.now;
  const binding = options.binding ?? (() => options.repo.readBinding());
  const localEntities =
    options.localEntities ??
    (() => {
      const current = binding();
      return current === null ? [] : options.repo.entities(current.id);
    });
  const remoteEntities = options.remoteEntities ?? (() => listRemoteEntities(options.session?.()));
  const remoteOps = options.session === undefined ? undefined : () => createRemoteOperations(options.session!());
  const restore =
    options.restore ?? (async (...args: Parameters<OperationInput['restore']>) => remoteOps!().restore(...args));
  const purge = options.purge ?? (async (...args: Parameters<OperationInput['purge']>) => remoteOps!().purge(...args));
  const applyCloud =
    options.applyCloud ??
    (async (...args: Parameters<NonNullable<OperationInput['applyCloud']>>) => remoteOps!().publish(...args));
  const previews = new Map<string, PreviewRecord>();
  let rangeRevision = 0;
  let state: SyncConnectionState = 'idle';
  let lastSuccessAt: number | null = null;

  const statuses = createStatus({
    repo: options.repo,
    registry: options.registry,
    now,
    // A bound backend the lifecycle never connected to is offline, not idle.
    state: () =>
      state === 'idle' && options.session !== undefined && binding() !== null && options.session() === undefined
        ? 'offline'
        : state,
    lastSuccessAt: () => lastSuccessAt,
    backendOptions: options.backendOptions,
    binding,
    accounts: options.accounts,
  });

  // A preview awaiting a decision is the user's turn, so a background poll must not overwrite it;
  // `stopped` belongs to disconnect(), which owns its own terminal state.
  options.onEngineStatus?.((value) => {
    if (state === 'preview-required' || state === 'disconnected') return;
    if (value === 'online') {
      state = 'idle';
      lastSuccessAt = now();
      return;
    }
    const mapped = ENGINE_STATES[value];
    if (mapped !== undefined) state = mapped;
  });

  const currentFence = async (
    snapshot?: readonly RemoteEntity[],
    localCommitId?: string,
    bindingSnapshot?: LocalBinding | null,
  ): Promise<PreviewFence> => {
    const current = bindingSnapshot === undefined ? binding() : bindingSnapshot;
    const remote = snapshot ?? (await remoteEntities());
    return {
      bindingId: current?.id ?? '',
      sessionGeneration: current?.sessionGeneration ?? 0,
      localCommitId: current === null ? '' : (localCommitId ?? latestCommitId(options.repo, current)),
      rangeRevision,
      remoteVersions: Object.fromEntries(remote.map((entity) => [entity.objectId, entity.version])),
    };
  };

  const captureLocal = (): {
    readonly binding: LocalBinding | null;
    readonly entities: readonly LocalEntity[];
    readonly localCommitId: string;
  } => {
    const capturedBinding = binding();
    if (capturedBinding === null) return { binding: null, entities: [], localCommitId: '' };
    const before = latestCommitId(options.repo, capturedBinding);
    const entities = snapshotLocalEntities(localEntities());
    const afterBinding = binding();
    const after = afterBinding?.id === capturedBinding.id ? latestCommitId(options.repo, capturedBinding) : '';
    if (afterBinding?.id !== capturedBinding.id || before !== after) throw new SyncPreviewError('preview-stale');
    return { binding: capturedBinding, entities, localCommitId: after };
  };

  const operationInput = (): OperationInput => ({
    repo: options.repo,
    binding,
    localEntities,
    remoteEntities,
    fence: currentFence,
    status: statuses.status,
    applyLocal: options.applyLocal,
    applyCloud,
    restore,
    persistOverrides: options.persistOverrides,
    persistProviderIdentity: options.persistProviderIdentity,
    purge,
    now,
  });

  const status = (): SyncStatus => statuses.status();
  const backends = (): SyncBackendView[] => statuses.backends();

  return {
    backends,
    status,
    async preview(input) {
      if (input.kind === 'connect') {
        const backend = options.registry?.().resolveSync(input.plugin, input.capability);
        const parsed = backend?.options.schema.safeParse(input.options);
        if (backend === undefined || parsed === undefined || !parsed.success)
          throw new SyncOperationError('backend-unavailable');
        const request = {
          ...input,
          options: parsed.data as Extract<SyncPreviewInput, { kind: 'connect' }>['options'],
        };
        const previewId = createPreviewToken(24, options.randomBytes);
        const expiresAt = now() + 10 * 60_000;
        const local = captureLocal();
        const fence = await currentFence([], local.localCommitId, local.binding);
        const built = buildPreview({
          request,
          local: local.entities,
          remote: [],
          fence,
          previewId,
          expiresAt,
          registry: options.registry?.(),
        });
        previews.set(previewId, built.record);
        return built.preview;
      }
      const local = captureLocal();
      if (local.binding === null) throw new SyncPreviewError('not-connected');
      const previewId = createPreviewToken(24, options.randomBytes);
      const expiresAt = now() + 10 * 60_000;
      const remote = snapshotRemoteEntities(await remoteEntities());
      const source = input.kind === 'join' ? await options.committedSource?.() : undefined;
      const built = buildPreview({
        request: input,
        local: local.entities,
        remote,
        fence: await currentFence(remote, local.localCommitId, local.binding),
        previewId,
        expiresAt,
        registry: options.registry?.(),
        ...(source === undefined ? {} : { source }),
      });
      previews.set(previewId, built.record);
      state = 'preview-required';
      return built.preview;
    },
    async apply(input: SyncApplyInput) {
      const record = previews.get(input.previewId);
      if (record === undefined) throw new SyncPreviewError('preview-stale');
      previews.delete(input.previewId);
      if (now() >= record.expiresAt) throw new SyncPreviewError('preview-stale');
      if (record.input.kind === 'connect') {
        await options.connect(record.input);
      } else {
        await applyPreview(operationInput(), record, input.decisions);
      }
      state = 'idle';
      lastSuccessAt = now();
      return status();
    },
    async setRange(providerId, included) {
      if (included !== false) throw new TypeError('sync range can only exclude a provider');
      rangeRevision += 1;
      return setRange(operationInput(), providerId);
    },
    async detach(providerId, loginSessionId) {
      if (options.detach === undefined) throw new Error('SYNC_OAUTH_COORDINATION_UNAVAILABLE');
      await options.detach(providerId, loginSessionId);
      return status();
    },
    async cancelDetach(providerId) {
      if (options.cancelDetach === undefined) throw new Error('SYNC_OAUTH_COORDINATION_UNAVAILABLE');
      await options.cancelDetach(providerId);
      return status();
    },
    async history(objectId) {
      const session = options.session?.();
      if (session === undefined) return [];
      const signal = new AbortController().signal;
      const headValue = await session.read(entityKey(objectId), signal);
      if (headValue.kind === 'absent') return [];
      const head = decodeHead(headValue.value);
      if (head.objectId !== objectId || head.state === 'purging') throw new SyncOperationError('operation-pending');
      const operationIds = [...new Set([...head.history, ...(head.current === null ? [] : [head.current])])];
      const items: SyncHistoryItem[] = [];
      for (const operationId of operationIds) {
        const value = await session.read(revisionKey(objectId, operationId), signal);
        if (value.kind === 'absent') continue;
        const record = decodeRevision(value.value);
        if (record.objectId !== objectId) throw new SyncOperationError('operation-pending');
        if (
          record.state === 'payload' &&
          (record.body.kind !== head.kind || record.body.logicalKey !== head.logicalKey)
        )
          throw new SyncOperationError('operation-pending');
        items.push({
          operationId,
          objectId,
          writtenAt: record.state === 'payload' ? (record.writtenAt ?? value.modifiedAt) : value.modifiedAt,
          current: head.current === operationId,
        });
      }
      return items;
    },
    async retry() {
      state = 'syncing';
      // A startup restore whose backend was offline left the lifecycle unstarted, so retry is
      // the reconnect path, not just a reconcile.
      await options.lifecycle?.start?.();
      if (options.session !== undefined && binding() !== null && options.session() === undefined) {
        state = 'offline';
        throw new SyncOperationError('backend-unavailable');
      }
      options.lifecycle?.activate();
      await options.lifecycle?.reconcile?.();
      state = 'idle';
      lastSuccessAt = now();
      return status();
    },
    async disconnect() {
      await options.lifecycle?.close();
      // Closing only tears down the in-memory lifecycle. The binding row stays active in SQLite,
      // so the next service start would read it and reconnect, silently undoing the disconnect.
      options.repo.clearBinding?.();
      state = 'disconnected';
      return status();
    },
  };
}

export type { SyncControlPlane } from '@aio-proxy/types';
