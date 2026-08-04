import {
  NpmLockError,
  type PluginRepository,
  type removeNpmPackageCache,
  resolveConfigTemplates,
  type withNpmPackageLifecycle,
} from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';

import { ConfigReloadRejectedError, type ConfigStore } from '../config-store';
import { PluginControlPlaneError, PluginDependenciesError } from './errors';
import { findPluginEntry, normalizedPackageName, pluginEntries } from './plugin-config';

const DEFAULT_AI_SDK_PACKAGE = '@ai-sdk/openai-compatible';

function dependentProviderIds(config: Readonly<Record<string, unknown>>, packageName: string): readonly string[] {
  const providers = resolveConfigTemplates(config['providers']);
  if (!isPlainObject(providers)) return [];
  const target = normalizedPackageName(packageName);
  if (target === undefined) return [];
  const referencesTarget = (value: unknown) => normalizedPackageName(value) === target;
  return Object.entries(providers)
    .flatMap(([providerId, provider]) => {
      if (!isPlainObject(provider)) return [];
      if (provider['kind'] === 'oauth' && referencesTarget(provider['plugin'])) return [providerId];
      if (
        provider['kind'] === 'ai-sdk' &&
        (referencesTarget(provider['packageName'] ?? DEFAULT_AI_SDK_PACKAGE) || referencesTarget(provider['package']))
      ) {
        return [providerId];
      }
      return [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function configUsesPackage(config: Readonly<Record<string, unknown>>, packageName: string): boolean {
  return findPluginEntry(config, packageName) !== undefined || dependentProviderIds(config, packageName).length > 0;
}

function removePlugin(config: Record<string, unknown>, packageName: string): Record<string, unknown> {
  const match = findPluginEntry(config, packageName);
  return {
    ...config,
    plugins: pluginEntries(config).filter((_entry, index) => index !== match?.index),
  };
}

export async function uninstallPlugin(
  packageName: string,
  options: {
    readonly builtInNames: ReadonlySet<string>;
    readonly configStore: ConfigStore;
    readonly removeNpmPackageCache: typeof removeNpmPackageCache;
    readonly repository: PluginRepository;
    readonly withNpmPackageLifecycle: typeof withNpmPackageLifecycle;
  },
): Promise<void> {
  if (options.configStore.file === undefined) throw new PluginControlPlaneError('config_unavailable', 409);
  if (options.builtInNames.has(packageName)) throw new PluginControlPlaneError('builtin_plugin', 409);
  const before = await options.configStore.file.read();
  const beforeDependencies = dependentProviderIds(before, packageName);
  if (beforeDependencies.length > 0) throw new PluginDependenciesError(beforeDependencies);

  try {
    await options.withNpmPackageLifecycle(packageName, async (assertOwnership) => {
      await options.configStore.mutateConfig(async (current) => {
        await assertOwnership();
        const dependencies = dependentProviderIds(current, packageName);
        if (dependencies.length > 0) throw new PluginDependenciesError(dependencies);
        return removePlugin(current, packageName);
      });
      await assertOwnership();
      const secret = options.repository.readPluginSecret(packageName);
      if (secret !== null && !options.repository.deletePluginSecret(packageName, secret.revision)) {
        throw new PluginControlPlaneError('concurrent_update', 409);
      }
    });
  } catch (error) {
    if (error instanceof ConfigReloadRejectedError) throw new PluginControlPlaneError('reload_failed', 422);
    if (error instanceof NpmLockError) throw new PluginControlPlaneError('npm_lock_failed', 423);
    throw error;
  }

  try {
    const guard = await options.configStore.captureProviderMutationGuard();
    const removed = await options.removeNpmPackageCache(
      packageName,
      async () => !configUsesPackage(await options.configStore.file!.read(), packageName),
      guard.runIfCurrent,
    );
    if (!removed) {
      const latest = await options.configStore.file.read();
      const dependencies = dependentProviderIds(latest, packageName);
      if (dependencies.length > 0) throw new PluginDependenciesError(dependencies);
      if (configUsesPackage(latest, packageName)) throw new PluginControlPlaneError('concurrent_update', 409);
    }
  } catch (error) {
    if (error instanceof NpmLockError) throw new PluginControlPlaneError('npm_lock_failed', 423);
    throw error;
  }
}
