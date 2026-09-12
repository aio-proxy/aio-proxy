import {
  type CommittedSource,
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
  SyncPreviewInput,
  SyncStatus,
} from '@aio-proxy/types';

import type { ServerSyncLifecycle } from './lifecycle';
import {
  applyPreview,
  assertDecisions,
  assertNoRetainedOAuth,
  setRange,
  SyncOperationError,
  type OperationInput,
} from './operations';
import {
  buildPreview,
  createPreviewToken,
  latestCommitId,
  listRemoteEntities,
  sameFence,
  snapshotRemoteEntities,
  snapshotLocalEntities,
  SyncPreviewError,
  type PreviewFence,
  type PreviewRecord,
  type RemoteEntity,
} from './preview';
import { createPreviewStore, type SyncConnectCandidate } from './preview-store';
import { createRemoteOperations, readHistory } from './remote-operations';
import { createStatus } from './status';

export type { SyncConnectCandidate } from './preview-store';

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
  /** How long a preview stays applicable before it is discarded. Defaults to ten minutes. */
  readonly previewTtlMs?: number;
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
  const previewTtlMs = options.previewTtlMs ?? 10 * 60_000;
  const binding = options.binding ?? (() => options.repo.readBinding());
  const localEntities =
    options.localEntities ??
    (() => {
      const current = binding();
      return current === null ? [] : options.repo.entities(current.id);
    });
  // Reads against the bound session outlive nothing but the binding, so a stalled `list`/`read`
  // after network loss would otherwise hang until the process exits. Disconnecting aborts them and
  // re-arms, since this control plane is created once and survives connect/disconnect cycles.
  let lifetime = new AbortController();
  const remoteEntities = options.remoteEntities ?? (() => listRemoteEntities(options.session?.(), lifetime.signal));
  const remoteOps =
    options.session === undefined ? undefined : () => createRemoteOperations(options.session!(), lifetime.signal);
  const restore =
    options.restore ?? (async (...args: Parameters<OperationInput['restore']>) => remoteOps!().restore(...args));
  const purge = options.purge ?? (async (...args: Parameters<OperationInput['purge']>) => remoteOps!().purge(...args));
  const applyCloud =
    options.applyCloud ??
    (async (...args: Parameters<NonNullable<OperationInput['applyCloud']>>) => remoteOps!().publish(...args));
  const previews = createPreviewStore({ now, onExpire: () => releasePreviewState() });
  let rangeRevision = 0;
  let stateBeforePreview: SyncConnectionState = 'idle';
  let lastSuccessAt: number | null = null;
  // `commit()` installs the new binding before the reviewed decisions land, so a publication that
  // fails partway leaves rows included on a baseline the backend has already moved past. The engine
  // is deliberately not started then — but nothing else may start it either, or reconciliation
  // imports the very revision the user chose to overwrite. Only a fresh connect preview re-reviews
  // every row against the bound backend, so that is the one thing that clears this. The binding row
  // carries the same fact durably (it is written pending and cleared here), because the process can
  // also exit mid-apply and a restarted service would otherwise reconcile that backend on sight.
  let connectApplyIncomplete = binding()?.connectPending === true;
  let state: SyncConnectionState = connectApplyIncomplete ? 'preview-required' : 'idle';

  // `preview-required` means a preview is waiting on the user. Remember what it displaced so a
  // preview that is consumed or expires without applying can hand the state back instead of
  // pinning it — a pinned `preview-required` also suppresses background engine outcomes.
  const enterPreviewRequired = (): void => {
    if (state !== 'preview-required') stateBeforePreview = state;
    state = 'preview-required';
  };
  const releasePreviewState = (): void => {
    // An incomplete connect apply is still the user's turn: the binding switched but the engine is
    // held, so reporting `idle` would claim a working backend that is not reconciling.
    if (connectApplyIncomplete) state = 'preview-required';
    else if (state === 'preview-required' && previews.size() === 0) state = stateBeforePreview;
  };

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
    shareOAuth: options.shareOAuth,
    purge,
    now,
  });

  const status = (): SyncStatus => statuses.status();
  const backends = (): SyncBackendView[] => statuses.backends();

  // The swap replaces the binding along with its commit history, so the binding and local-commit
  // halves of the reviewed fence describe a world that will no longer exist. The cloud half is what
  // the decisions were actually made against: re-read it through the candidate's own session while
  // it is still unbound, so a drifted backend or a malformed decision set is rejected before the
  // service switches. Only then run the decisions, against the reviewed fence so it is not
  // re-checked against the replaced binding.
  const applyConnect = async (
    candidate: SyncConnectCandidate,
    record: PreviewRecord,
    decisions: SyncApplyInput['decisions'],
  ): Promise<void> => {
    assertDecisions(record, decisions);
    const remote = await candidate.refresh();
    // The cloud half is re-read above, but the reviewed rows were projected from local state too: a
    // configuration change between preview and Apply would otherwise publish the superseded body or
    // overwrite the intervening edit with a cloud value, and the commit guard is disabled below.
    const local = captureLocal();
    const observed = await currentFence(remote, local.localCommitId, local.binding);
    if (!sameFence(record.fence, observed)) throw new SyncPreviewError('preview-stale');
    await candidate.commit();
    // Deferring the engine exists precisely so reconciliation never sees these objects before the
    // reviewed decisions land. A writer can still move a head after the final refresh, and then a
    // local-choice publication throws with its row left included on the old baseline — starting the
    // engine anyway would import the very revision the user chose to overwrite. Staying unreconciled
    // until a fresh connect preview re-reviews the backend is the safe half of that trade.
    connectApplyIncomplete = true;
    await applyPreview({ ...operationInput(), fence: async () => record.fence }, record, decisions);
    candidate.activate();
    // The binding row was written pending by the connect that created it, so this is what tells a
    // restarted service the reviewed Apply actually finished and the backend may be reconciled.
    const bound = binding();
    if (bound !== null) options.repo.setConnectPending?.(bound.id, false);
    connectApplyIncomplete = false;
  };

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
        // A pending candidate the user walked away from still holds an open backend session.
        await previews.disposePending();
        // The replacement may still fail to connect, and then no preview is left to expire or
        // apply: hand the state back now rather than pinning `preview-required` for good.
        releasePreviewState();
        const candidate = await options.connect(request);
        try {
          const previewId = createPreviewToken(24, options.randomBytes);
          const expiresAt = now() + previewTtlMs;
          const local = captureLocal();
          const remote = snapshotRemoteEntities(candidate.remote);
          const built = buildPreview({
            request,
            local: local.entities,
            remote,
            fence: await currentFence(remote, local.localCommitId, local.binding),
            previewId,
            expiresAt,
            registry: options.registry?.(),
          });
          previews.retain(previewId, built.record, expiresAt, candidate);
          enterPreviewRequired();
          return built.preview;
        } catch (error) {
          await candidate.dispose().catch(() => {});
          throw error;
        }
      }
      const local = captureLocal();
      if (local.binding === null) throw new SyncPreviewError('not-connected');
      const previewId = createPreviewToken(24, options.randomBytes);
      const expiresAt = now() + previewTtlMs;
      const remote = snapshotRemoteEntities(await remoteEntities());
      // An override pins a path of the authored body, exactly as a join publishes one, so both need
      // the committed source. Without it a local-only or excluded object previews a null body and
      // the override persists `undefined` for the path it was meant to keep.
      const source =
        input.kind === 'join' || input.kind === 'overrides' ? await options.committedSource?.() : undefined;
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
      previews.retain(previewId, built.record, expiresAt);
      enterPreviewRequired();
      return built.preview;
    },
    async apply(input: SyncApplyInput) {
      const { record, candidate } = previews.take(input.previewId);
      if (record === undefined) throw new SyncPreviewError('preview-stale');
      try {
        if (now() >= record.expiresAt) {
          await candidate?.dispose().catch(() => {});
          throw new SyncPreviewError('preview-stale');
        }
        if (record.input.kind === 'connect') {
          if (candidate === undefined) throw new SyncPreviewError('preview-stale');
          try {
            await applyConnect(candidate, record, input.decisions);
          } catch (error) {
            await candidate.dispose().catch(() => {});
            throw error;
          }
        } else {
          await applyPreview(operationInput(), record, input.decisions);
        }
      } catch (error) {
        // The preview was consumed, so there is nothing left for the user to decide on.
        releasePreviewState();
        throw error;
      }
      state = 'idle';
      lastSuccessAt = now();
      return status();
    },
    async setRange(providerId, included) {
      if (included !== false) throw new TypeError('sync range can only exclude a provider');
      rangeRevision += 1;
      const run = async () => setRange(operationInput(), providerId);
      return options.withFence === undefined ? run() : options.withFence(run);
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
      return readHistory(options.session?.(), objectId, lifetime.signal);
    },
    async retry() {
      // Retry is a reconnect, not a way around a review: a connect apply that failed after the
      // binding switched left rows on a baseline the backend has moved past, and activating the
      // engine here would import exactly what the user chose to overwrite. Only a new connect
      // preview re-reviews those rows.
      if (connectApplyIncomplete) throw new SyncPreviewError('preview-stale');
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
      const active = binding();
      if (active !== null) assertNoRetainedOAuth(options.repo, active.id);
      lifetime.abort();
      lifetime = new AbortController();
      await options.lifecycle?.close();
      // Closing only tears down the in-memory lifecycle. The binding row stays active in SQLite,
      // so the next service start would read it and reconnect, silently undoing the disconnect.
      options.repo.clearBinding?.();
      state = 'disconnected';
      connectApplyIncomplete = false;
      return status();
    },
  };
}

export type { SyncControlPlane } from '@aio-proxy/types';
