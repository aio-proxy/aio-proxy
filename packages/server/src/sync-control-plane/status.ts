import type { PluginRegistry, SyncRepository } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { ProviderSyncView, SyncBackendView, SyncConnectionState, SyncStatus } from '@aio-proxy/types';

import { objectValue } from './preview';

export type StatusInput = {
  readonly repo: SyncRepository;
  readonly registry?: () => PluginRegistry;
  readonly now?: () => number;
  readonly lastSuccessAt?: () => number | null;
  readonly state?: () => SyncConnectionState;
};

function dashboardForm(form: readonly Record<string, unknown>[], options: JsonValue): SyncBackendView['form'] {
  const values = objectValue(options);
  return form.map((field) => {
    if (field['type'] !== 'secret') return field as SyncBackendView['form'][number];
    return { ...field, configured: values[field['key'] as string] !== undefined } as SyncBackendView['form'][number];
  });
}

export function createStatus(input: StatusInput): { status: () => SyncStatus; backends: () => SyncBackendView[] } {
  const state = input.state ?? (() => 'idle' as const);
  return {
    backends() {
      return (input.registry?.().syncCapabilities() ?? []).map(({ plugin, capability, backend }) => ({
        plugin,
        capability,
        displayName: backend.displayName,
        form: dashboardForm(
          backend.options.form as readonly Record<string, unknown>[],
          input.repo.readBinding()?.options ?? {},
        ),
      }));
    },
    status() {
      const binding = input.repo.readBinding();
      const entities = binding === null ? [] : input.repo.entities(binding.id);
      const pendingOperations =
        binding === null ? 0 : input.repo.outbox(binding.id).length + input.repo.pendingCommits(binding.id).length;
      return {
        state: binding === null ? 'disconnected' : state(),
        backend:
          binding === null
            ? null
            : { plugin: binding.plugin, capability: binding.capability, spaceId: binding.spaceId },
        providers: entities
          .filter((entity) => entity.kind === 'provider')
          .map((entity) => {
            const oauthState = entity.oauth?.mode === 'share-pending' ? 'unverified' : entity.oauth?.mode;
            return {
              providerId: entity.logicalKey,
              objectId: entity.objectId,
              included: entity.mode === 'included',
              credentialState: oauthState ?? (entity.mode === 'included' ? 'local' : 'independent'),
              pendingReason: entity.pendingReason,
            } satisfies ProviderSyncView;
          }),
        pendingOperations,
        lastSuccessAt: input.lastSuccessAt?.() ?? null,
      } satisfies SyncStatus;
    },
  };
}
