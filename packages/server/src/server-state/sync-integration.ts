import {
  AtomicConfigFile,
  createSyncRepository,
  parseRuntimeConfig,
  parsePluginSchema,
  type PluginRegistrySnapshot,
  type PluginRepository,
  type JsonValue,
  type OAuthSharingService,
  type SharedOAuthCoordinator,
} from '@aio-proxy/core';
import type { OpenDbHandle } from '@aio-proxy/core/db';

import type { createFifoQueue } from '../fifo-queue';
import {
  checkPrerequisites,
  createLocalSyncPort,
  createServerSyncLifecycle,
  readOAuthActivationEvidence,
  type OAuthActivationEvidence,
} from '../sync-control-plane';
import { createSyncCommitHooks } from '../sync-control-plane/commit';
import { commitConfig, type ServerRuntime } from './lifecycle';
import type { ServerStateOptions } from './types';

export function createSyncIntegration(
  runtime: ServerRuntime,
  dbHandle: OpenDbHandle,
  repository: PluginRepository,
  plugins: () => PluginRegistrySnapshot,
  configFile: AtomicConfigFile | undefined,
  options: ServerStateOptions,
  queue: ReturnType<typeof createFifoQueue>,
  syncRepository = createSyncRepository(dbHandle.sqlite),
  onCoordinator?: (coordinator: SharedOAuthCoordinator | undefined) => void,
  onSharing?: (sharing: OAuthSharingService | undefined) => void,
) {
  const syncBinding = syncRepository.readBinding();
  if (syncBinding === null || configFile === undefined || options.configPath === undefined) {
    return {
      syncRepository,
      syncBinding,
      syncPort: undefined,
      syncApplyCandidate: async () => {},
      lifecycle: undefined,
      configPath: options.configPath,
    };
  }
  const syncApplyCandidate = async (raw: Record<string, JsonValue>, origin: 'local' | 'remote'): Promise<void> => {
    await configFile.replace(() => raw, {
      validateCandidate: (candidate) => void parseRuntimeConfig(candidate),
      verify: async (candidate) => {
        await commitConfig(runtime, parseRuntimeConfig(candidate), origin === 'remote' ? 'sync-remote' : 'sync-local');
      },
    });
  };
  const pluginVersions = () =>
    new Map(
      [...plugins().plugins]
        .filter(([, plugin]) => plugin.version !== undefined)
        .map(([name, plugin]) => [name, plugin.version!] as const),
    );
  const checkActivation = async (raw: Record<string, JsonValue>, body: import('@aio-proxy/core').EntityBody) => {
    let credentialValid = true;
    let oauthEvidence: OAuthActivationEvidence | undefined;
    const value = body.value;
    if (
      body.kind === 'provider' &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as Record<string, JsonValue>)['kind'] === 'oauth'
    ) {
      const valueRecord = value as Record<string, JsonValue>;
      const plugin = typeof valueRecord['plugin'] === 'string' ? valueRecord['plugin'] : undefined;
      const capability = typeof valueRecord['capability'] === 'string' ? valueRecord['capability'] : undefined;
      const adapter =
        plugin === undefined || capability === undefined
          ? undefined
          : plugins().registry.resolveOAuth(plugin, capability);
      const account = repository.readAccount(body.logicalKey);
      if (
        plugin === undefined ||
        capability === undefined ||
        adapter === undefined ||
        account === null ||
        account.plugin !== plugin ||
        account.capability !== capability
      )
        credentialValid = false;
      else {
        credentialValid = (await parsePluginSchema(adapter.credentials, account.credential)).ok;
        oauthEvidence = readOAuthActivationEvidence(
          account,
          adapter.credentialSync?.formatVersion,
          adapter.credentialSync?.multiDevice?.evidenceId,
          syncRepository.entities(syncBinding.id).find((entity) => entity.logicalKey === body.logicalKey),
        );
      }
    }
    return checkPrerequisites({
      raw,
      body,
      apply: async () => {},
      dependencies: {
        installedPackages: pluginVersions(),
        missingEnv: [],
        oauthVerified: credentialValid,
        credentialValid,
        ...(oauthEvidence === undefined ? {} : { oauthEvidence }),
      },
    });
  };
  const syncPort = createLocalSyncPort({
    configPath: options.configPath,
    configFile,
    repo: syncRepository,
    accounts: repository,
    bindingId: syncBinding.id,
    bindingGeneration: syncBinding.sessionGeneration,
    enqueue: queue,
    registry: () => plugins().registry,
    applyCandidate: syncApplyCandidate,
    checkActivation,
    pluginVersions,
  });
  const lifecycle = createServerSyncLifecycle({
    configPath: options.configPath,
    configFile,
    repo: syncRepository,
    accounts: repository,
    registry: () => plugins().registry,
    enqueue: queue,
    applyCandidate: syncApplyCandidate,
    pluginVersions,
    localPort: syncPort,
    onCoordinator,
    onSharing,
    withProviderGate: runtime.withProviderGate,
    deferEngine: true,
  });
  return { syncRepository, syncBinding, syncPort, syncApplyCandidate, lifecycle, configPath: options.configPath };
}

export function syncCommitOption(integration: ReturnType<typeof createSyncIntegration>) {
  return integration.syncBinding === null || integration.syncPort === undefined
    ? undefined
    : createSyncCommitHooks({
        path: integration.configPath,
        repo: integration.syncRepository,
        bindingId: integration.syncBinding.id,
        port: integration.syncPort,
      });
}

export async function startSyncIntegration(
  runtime: ServerRuntime,
  integration: ReturnType<typeof createSyncIntegration>,
  registerStartupCleanup: (cleanup: () => void | Promise<void>) => void,
): Promise<void> {
  if (integration.lifecycle === undefined) return;
  runtime.sync = integration.lifecycle;
  registerStartupCleanup(() => integration.lifecycle?.close());
  try {
    await integration.lifecycle.start();
  } catch (error) {
    await integration.lifecycle.close().catch(() => {});
    throw error;
  }
}
