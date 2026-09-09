import {
  decodeHead,
  decodeRevision,
  entityKey,
  revisionKey,
  type EntityBody,
  type LocalBinding,
  type LocalEntity,
  type PluginRegistry,
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
import { applyPreview, setRange, type OperationInput } from './operations';
import {
  buildPreview,
  createPreviewToken,
  latestCommitId,
  listRemoteEntities,
  SyncPreviewError,
  type PreviewFence,
  type PreviewRecord,
  type RemoteEntity,
} from './preview';
import { createStatus } from './status';

export type SyncControlPlaneOptions = {
  readonly repo: SyncRepository;
  readonly registry?: () => PluginRegistry;
  readonly binding?: () => LocalBinding | null;
  readonly localEntities?: () => readonly LocalEntity[];
  readonly session?: () => SyncSession | undefined;
  readonly remoteEntities?: () => Promise<readonly RemoteEntity[]>;
  readonly lifecycle?: Pick<ServerSyncLifecycle, 'activate' | 'close'>;
  readonly applyLocal?: (candidate: EntityBody | null, current: LocalEntity | undefined) => Promise<void>;
  readonly applyCloud?: (candidate: EntityBody | null, current: LocalEntity | undefined) => Promise<void>;
  readonly connect?: (input: Extract<SyncPreviewInput, { kind: 'connect' }>) => Promise<void>;
  readonly detach?: (providerId: string, loginSessionId: string) => Promise<void>;
  readonly cancelDetach?: (providerId: string) => Promise<void>;
  readonly purge?: (objectId: string) => Promise<void>;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly secretKeys?: () => ReadonlySet<string>;
};

export function createSyncControlPlane(options: SyncControlPlaneOptions): SyncControlPlane {
  const now = options.now ?? Date.now;
  const binding = options.binding ?? (() => options.repo.readBinding());
  const localEntities =
    options.localEntities ??
    (() => {
      const current = binding();
      return current === null ? [] : options.repo.entities(current.id);
    });
  const remoteEntities = options.remoteEntities ?? (() => listRemoteEntities(options.session?.()));
  const previews = new Map<string, PreviewRecord>();
  let rangeRevision = 0;
  let state: SyncConnectionState = 'idle';
  let lastSuccessAt: number | null = null;

  const statuses = createStatus({
    repo: options.repo,
    registry: options.registry,
    now,
    state: () => state,
    lastSuccessAt: () => lastSuccessAt,
  });

  const currentFence = async (): Promise<PreviewFence> => {
    const current = binding();
    const remote = await remoteEntities();
    return {
      bindingId: current?.id ?? '',
      sessionGeneration: current?.sessionGeneration ?? 0,
      localCommitId: current === null ? '' : latestCommitId(options.repo, current),
      rangeRevision,
      remoteVersions: Object.fromEntries(remote.map((entity) => [entity.objectId, entity.version])),
    };
  };

  const operationInput = (): OperationInput => ({
    repo: options.repo,
    binding,
    localEntities,
    remoteEntities,
    fence: currentFence,
    status: statuses.status,
    ...(options.applyLocal === undefined ? {} : { applyLocal: options.applyLocal }),
    ...(options.applyCloud === undefined ? {} : { applyCloud: options.applyCloud }),
    now,
  });

  const status = (): SyncStatus => statuses.status();
  const backends = (): SyncBackendView[] => statuses.backends();

  return {
    backends,
    status,
    async preview(input) {
      if (input.kind === 'connect') {
        const previewId = createPreviewToken(24, options.randomBytes);
        const expiresAt = now() + 10 * 60_000;
        const fence = await currentFence();
        const built = buildPreview({
          request: input,
          local: localEntities(),
          remote: [],
          fence,
          previewId,
          expiresAt,
          secretKeys: options.secretKeys?.(),
        });
        previews.set(previewId, built.record);
        return built.preview;
      }
      if (binding() === null) throw new SyncPreviewError('not-connected');
      const previewId = createPreviewToken(24, options.randomBytes);
      const expiresAt = now() + 10 * 60_000;
      const built = buildPreview({
        request: input,
        local: localEntities(),
        remote: await remoteEntities(),
        fence: await currentFence(),
        previewId,
        expiresAt,
        secretKeys: options.secretKeys?.(),
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
        await options.connect?.(record.input);
      } else if (record.input.kind === 'purge') {
        for (const candidate of record.rows) await options.purge?.(candidate.row.objectId);
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
      const operationIds = [...new Set([...head.history, ...(head.current === null ? [] : [head.current])])];
      const items: SyncHistoryItem[] = [];
      for (const operationId of operationIds) {
        const value = await session.read(revisionKey(objectId, operationId), signal);
        if (value.kind === 'absent') continue;
        const record = decodeRevision(value.value);
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
      options.lifecycle?.activate();
      state = 'idle';
      lastSuccessAt = now();
      return status();
    },
    async disconnect() {
      await options.lifecycle?.close();
      state = 'disconnected';
      return status();
    },
  };
}

export type { SyncControlPlane } from '@aio-proxy/types';
