import type { LocalBinding, PluginRegistry, PluginRepository, SyncRepository } from '@aio-proxy/core';
import type { JsonValue } from '@aio-proxy/plugin-sdk';
import type { ProviderSyncView, SyncBackendView, SyncConnectionState, SyncStatus } from '@aio-proxy/types';

import { objectValue } from './preview';

export type StatusInput = {
  readonly repo: SyncRepository;
  readonly registry?: () => PluginRegistry;
  readonly now?: () => number;
  readonly lastSuccessAt?: () => number | null;
  readonly state?: () => SyncConnectionState;
  readonly backendOptions?: (plugin: string, capability: string) => JsonValue | undefined;
  readonly binding?: () => LocalBinding | null;
  readonly accounts?: PluginRepository;
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
  const binding = input.binding ?? (() => input.repo.readBinding());
  return {
    backends() {
      return (input.registry?.().syncCapabilities() ?? []).map(({ plugin, capability, backend }) => ({
        plugin,
        capability,
        displayName: backend.displayName,
        form: dashboardForm(
          backend.options.form as readonly Record<string, unknown>[],
          input.backendOptions?.(plugin, capability) ?? {},
        ),
      }));
    },
    status() {
      const currentBinding = binding();
      const entities = currentBinding === null ? [] : input.repo.entities(currentBinding.id);
      const pendingOperations =
        currentBinding === null
          ? 0
          : input.repo.outbox(currentBinding.id).length +
            input.repo.pendingCommits(currentBinding.id).length +
            input.repo.oauthJournals(currentBinding.id).length +
            (input.accounts?.listPendingAccountOperations().length ?? 0);
      return {
        state: currentBinding === null ? 'disconnected' : state(),
        backend:
          currentBinding === null
            ? null
            : { plugin: currentBinding.plugin, capability: currentBinding.capability, spaceId: currentBinding.spaceId },
        providers: entities
          .filter((entity) => entity.kind === 'provider')
          .map((entity) => {
            const pendingState = entity.pendingReason;
            const oauthState =
              pendingState === 'refresh-deferred' ||
              pendingState === 'result-uncertain' ||
              pendingState === 'login-required'
                ? pendingState
                : entity.oauth?.mode === 'share-pending'
                  ? 'unverified'
                  : entity.oauth?.mode;
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
