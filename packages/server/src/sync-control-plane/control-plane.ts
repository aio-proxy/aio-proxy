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

import { createFifoQueue } from '../fifo-queue';
import { createFenceReader, sourceDigest } from './fence';
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
  listRemoteEntities,
  sameFence,
  snapshotRemoteEntities,
  SyncPreviewError,
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

const ENGINE_STATES: Readonly<Record<string, SyncConnectionState>> = {
  offline: 'offline',
  quota: 'quota',
  'identity-changed': 'identity-changed',
  error: 'error',
};

/**
 * The control plane as the service owns it. A connect preview the user walked away from is held here
 * alone — its candidate backend has no binding and no lifecycle — so shutdown has to release it
 * through this, or the session it holds open (for CloudKit, a native helper process) outlives the
 * service and delays the next start.
 */
export type ServerSyncControlPlane = SyncControlPlane & { readonly dispose: () => Promise<void> };

// eslint-disable-next-line max-lines-per-function -- this assembles the public operations over one fence owner
export function createSyncControlPlane(options: SyncControlPlaneOptions): ServerSyncControlPlane {
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

  const { fence: currentFence, captureLocal } = createFenceReader({
    repo: options.repo,
    binding,
    localEntities,
    remoteEntities,
    ...(options.committedSource === undefined ? {} : { committedSource: options.committedSource }),
    rangeRevision: () => rangeRevision,
  });

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
    accounts: options.accounts,
    rangeRevision: () => rangeRevision,
    purge,
    now,
  });

  const status = (): SyncStatus => statuses.status();
  const backends = (): SyncBackendView[] => statuses.backends();

  // Applying takes the preview out of the store, so `disposePending()` can no longer see an Apply
  // already in flight and two Applies can overlap. Both would then pass their fence and local-commit
  // checks — those run inside applyPreview() — before either mutates anything, and the second would
  // write its stale reviewed body over the first reviewed decision and still report success. For
  // connect the overlap is worse: `commit()` serializes only its own swap, so the second swap
  // replaces and closes the first lifecycle while the first call is still publishing to it.
  // Serialized, the later Apply re-reads the committed state into its fence and is rejected as
  // stale. This is not the configuration queue, so `applyLocal` may still re-enter that one.
  const applies = createFifoQueue();

  // The candidates an Apply is working on: `take()` has removed them from the preview store, so
  // nothing else can reach them to release their backend session. A set, not one handle: a second
  // Apply is taken out of the store as soon as it is called and then waits its turn in the FIFO, so
  // at shutdown both the executing candidate and the queued one need releasing.
  const applying = new Set<SyncConnectCandidate>();
  // Releasing those candidates yields, which frees the FIFO and lets the next queued Apply start on a
  // candidate teardown has just disposed — it would bind the service to a dead backend session on the
  // way out. Shutdown therefore refuses the swap outright rather than racing it.
  let closing = false;

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
    if (closing) throw new SyncOperationError('backend-unavailable');
    assertDecisions(record, decisions);
    const remote = await candidate.refresh();
    // The cloud half is re-read above, but the reviewed rows were projected from local state too: a
    // configuration change between preview and Apply would otherwise publish the superseded body or
    // overwrite the intervening edit with a cloud value, and the commit guard is disabled below.
    const local = captureLocal();
    const observed = await currentFence(local, remote, true);
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
    // Only the pending candidates: the bound backend is the sync lifecycle's to close, and a preview
    // record without one holds nothing but memory the process is about to drop. A candidate mid-Apply
    // has already left the store, so it is tracked separately — disposing it aborts the refresh it
    // may be stalled in, which is what lets shutdown proceed instead of waiting out the bound.
    dispose: async () => {
      closing = true;
      for (const candidate of applying) await candidate.dispose().catch(() => {});
      await previews.disposePending();
    },
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
          // A candidate still opening is in neither `applying` nor the preview store, so shutdown
          // cannot reach it: retaining one that finished after dispose() returned would leave its
          // backend session — a native helper, for CloudKit — alive until the preview expires. The
          // catch below releases it, which is also what a connection stalled past teardown gets.
          if (closing) throw new SyncOperationError('backend-unavailable');
          const previewId = createPreviewToken(24, options.randomBytes);
          const expiresAt = now() + previewTtlMs;
          const local = captureLocal();
          const remote = snapshotRemoteEntities(candidate.remote);
          // Reviewing the cloud side alone would offer `cloud` as the only choice for an identity the
          // authored configuration also has, and applying would import over it. Before the first
          // binding there are no rows to project from, so the committed configuration is the local
          // side. A backend that cannot supply it is reviewed cloud-only rather than not at all.
          const source = await options.committedSource?.().catch(() => undefined);
          const built = buildPreview({
            request,
            local: local.entities,
            remote,
            // The exact source read above, not a second sample: an edit landing between the two would
            // fence the newer digest against rows projected from the older one, and the Apply — which
            // reads live — would then match it and publish the superseded body.
            fence: await currentFence(local, remote, true, sourceDigest(source)),
            previewId,
            expiresAt,
            registry: options.registry?.(),
            ...(source === undefined ? {} : { source }),
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
      // An incomplete connect apply switched the binding and left the engine held, so these rows sit
      // on a baseline the backend has moved past and only a fresh connect review can clear them.
      // Reviewing a join, restore, override, or purge against them would report success and hand the
      // state back to `idle` while synchronization stays stopped.
      if (connectApplyIncomplete) throw new SyncPreviewError('preview-stale');
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
        fence: await currentFence(local, remote),
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
          applying.add(candidate);
          try {
            await applies(() => applyConnect(candidate, record, input.decisions));
          } catch (error) {
            await candidate.dispose().catch(() => {});
            throw error;
          } finally {
            applying.delete(candidate);
          }
        } else {
          // A preview captured before a connect apply failed reviews rows that now belong to another
          // binding, and applying it would set the state to `idle` with the engine still held.
          if (connectApplyIncomplete) throw new SyncPreviewError('preview-stale');
          await applies(() => applyPreview(operationInput(), record, input.decisions));
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
      const run = async () => {
        // Bumped with the mutation, not when Leave was requested: a Leave queued behind an Apply
        // would otherwise let a preview taken while the row is still included capture the new
        // revision, pass `sameFence()` afterwards, and re-include the Provider Leave just excluded.
        rangeRevision += 1;
        return setRange(operationInput(), providerId);
      };
      // An Apply awaits its remote write outside the mutation fence, and the reviewed import it runs
      // afterwards deliberately bypasses the excluded-row guard, because it writes into a row whose
      // inclusion it records immediately after. Excluding the Provider in that window would therefore
      // still land the cloud body in the configuration after Leave reported success — the range check
      // in the reviewed path only holds the row's mode back. The same FIFO orders Leave against the
      // whole Apply, so it either invalidates the reviewed fence or takes effect once the import is
      // done. A preview captured before this bump is stale either way.
      return applies(() => (options.withFence === undefined ? run() : options.withFence(run)));
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
      //
      // Reading that flag outside the FIFO is not enough. A connect Apply already in flight has not
      // reached its swap yet, and the integration wrapper resolves `integration.lifecycle` per call,
      // so a Retry that passed the check and is awaiting `start()` resumes on the candidate the swap
      // installed — activating and reconciling it before the reviewed decisions land, which imports
      // the cloud state the user has not applied. Queued, it sees the settled engine and flag.
      await applies(async () => {
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
      });
      return status();
    },
    async disconnect() {
      // A connect Apply past its final fence check still installs a binding and publishes to it
      // through the candidate's own session, which aborting `lifetime` does not reach. Interleaved,
      // the teardown would close the old lifecycle, clear its binding and report success while
      // synchronization came straight back up. The same FIFO puts it after that Apply.
      await applies(async () => {
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
      });
      return status();
    },
  };
}

export type { SyncControlPlane } from '@aio-proxy/types';
