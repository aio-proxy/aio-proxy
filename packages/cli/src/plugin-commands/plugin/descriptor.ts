import { pathToFileURL } from 'node:url';

import {
  AtomicConfigCommitUncertainError,
  classifyInstalledPackage as classifyCoreInstalledPackage,
  ConfigSpecValidationError,
  findInstalledNpmPackage,
  InstalledPackageInvalidError,
  type NpmPackageInfo,
  observedPromiseDeadline,
  PLUGIN_IMPORT_TIMEOUT_MS,
  PluginSetupInvalidError,
  type PluginSecretSnapshot,
  stagePluginDescriptor,
  validateConfigSpec,
} from '@aio-proxy/core';
import { isPluginDescriptor, type PluginDescriptor } from '@aio-proxy/plugin-sdk';

import { cloneInertJson } from '../form';
import { entries, packageNameOf, pluginEntry, replacePlugin, sameJson } from './config-entry';
import type { PluginLifecycleDeps, SecretRepository } from './deps';
import { createCliPluginDiagnosticFactory } from './deps';
import {
  PluginConfigChangedError,
  PluginDescriptorInvalidError,
  PluginNotConfiguredError,
  PluginNotInstalledError,
  PluginSetupValidationError,
} from './errors';

function descriptorFromModule(packageName: string, imported: unknown): PluginDescriptor<unknown> {
  if (imported === null || typeof imported !== 'object') throw new PluginDescriptorInvalidError(packageName);
  const descriptor = Reflect.get(imported, 'default');
  if (!isPluginDescriptor(descriptor)) throw new PluginDescriptorInvalidError(packageName);
  const typed = descriptor as PluginDescriptor<unknown>;
  try {
    if (typed.metadata.options !== undefined) validateConfigSpec(typed.metadata.options);
  } catch (error) {
    if (error instanceof ConfigSpecValidationError) throw new PluginDescriptorInvalidError(packageName);
    throw error;
  }
  return typed;
}

async function importInstalledModule(
  packageName: string,
  installed: NpmPackageInfo,
  deps: PluginLifecycleDeps,
): Promise<unknown> {
  const attempt = crypto.randomUUID();
  const entrypoint = pathToFileURL(installed.entrypoint);
  entrypoint.searchParams.set('aio_proxy_cli_attempt', attempt);
  return observedPromiseDeadline(
    deps.importPackage({ packageName, version: installed.version, entrypoint: entrypoint.href, attempt }),
    {
      timeoutMs: deps.importTimeoutMs ?? PLUGIN_IMPORT_TIMEOUT_MS,
      timeoutError: () => new PluginDescriptorInvalidError(packageName),
    },
  );
}

export async function loadDescriptor(
  packageName: string,
  installed: NpmPackageInfo,
  deps: PluginLifecycleDeps,
): Promise<PluginDescriptor<unknown>> {
  return descriptorFromModule(packageName, await importInstalledModule(packageName, installed, deps));
}

// `plugin add` installs both aio plugins (default PluginDescriptor export) and
// AI SDK provider packages (e.g. @ai-sdk/anthropic), which expose only a `create*`
// factory and no descriptor. Classify the freshly installed module by importing it
// once so the caller can install a provider into the cache without inventing a
// descriptor, while a package that is neither is still rejected as invalid.
export type InstalledPackageClassification =
  | { readonly kind: 'plugin'; readonly descriptor: PluginDescriptor<unknown> }
  | { readonly kind: 'ai-sdk-provider' };

export async function classifyInstalledPackage(
  packageName: string,
  installed: NpmPackageInfo,
  deps: PluginLifecycleDeps,
): Promise<InstalledPackageClassification> {
  try {
    return await classifyCoreInstalledPackage(packageName, installed, deps.importPackage, deps.importTimeoutMs);
  } catch (error) {
    if (error instanceof InstalledPackageInvalidError) throw new PluginDescriptorInvalidError(packageName);
    throw error;
  }
}

export async function stageDescriptor(
  packageName: string,
  version: string,
  descriptor: PluginDescriptor<unknown>,
  publicValues: Record<string, unknown>,
  secrets: Record<string, unknown>,
): Promise<void> {
  const stagingPublicValues = cloneInertJson(publicValues);
  const stagingSecrets = cloneInertJson(secrets);
  try {
    await stagePluginDescriptor({
      packageName,
      version,
      descriptor,
      publicValues: stagingPublicValues,
      secrets: stagingSecrets,
      diagnostics: createCliPluginDiagnosticFactory(),
      logger: () => {},
    });
  } catch (error) {
    if (error instanceof PluginSetupInvalidError) {
      throw new PluginSetupValidationError(packageName, error.diagnostic.summary);
    }
    throw error;
  }
}

async function compensateSecret(
  packageName: string,
  previous: PluginSecretSnapshot | null,
  appliedRevision: number | null,
  repository: SecretRepository,
): Promise<void> {
  if (appliedRevision === null) return;
  if (previous === null) {
    repository.deletePluginSecret(packageName, appliedRevision);
    return;
  }
  try {
    repository.writePluginSecret(packageName, appliedRevision, previous.value);
  } catch (error) {
    if (repository.readPluginSecret(packageName)?.revision !== appliedRevision) return;
    throw error;
  }
}

export async function commitPluginConfig(
  packageName: string,
  publicValues: Record<string, unknown>,
  secrets: Record<string, unknown>,
  previousSecret: PluginSecretSnapshot | null,
  deps: PluginLifecycleDeps,
  options: { readonly expectedEntry?: unknown; readonly assertPackageOwnership?: () => Promise<void> } = {},
): Promise<void> {
  let appliedRevision: number | null = null;
  try {
    await deps.config.transaction(async (current) => {
      if (Object.hasOwn(options, 'expectedEntry')) {
        const latest = entries(current).find((entry) => packageNameOf(entry) === packageName);
        if (latest === undefined) throw new PluginNotConfiguredError(packageName);
        if (!sameJson(latest, options.expectedEntry)) throw new PluginConfigChangedError(packageName);
      }
      const latestSecret = deps.repository.readPluginSecret(packageName);
      if (
        (latestSecret?.revision ?? null) !== (previousSecret?.revision ?? null) ||
        !sameJson(latestSecret?.value, previousSecret?.value)
      ) {
        throw new PluginConfigChangedError(packageName);
      }
      await options.assertPackageOwnership?.();
      if (
        (previousSecret === null && Object.keys(secrets).length > 0) ||
        (previousSecret !== null && !sameJson(previousSecret.value, secrets))
      ) {
        appliedRevision = deps.repository.writePluginSecret(
          packageName,
          previousSecret?.revision ?? null,
          secrets,
        ).revision;
      }
      return { next: replacePlugin(current, packageName, pluginEntry(packageName, publicValues)), result: undefined };
    });
  } catch (error) {
    if (!(error instanceof AtomicConfigCommitUncertainError)) {
      await compensateSecret(packageName, previousSecret, appliedRevision, deps.repository);
    }
    throw error;
  }
}

export async function installedForConfig(packageName: string, deps: PluginLifecycleDeps): Promise<NpmPackageInfo> {
  const installed = await (deps.findInstalledNpmPackage ?? findInstalledNpmPackage)(packageName);
  if (installed === null) throw new PluginNotInstalledError(packageName);
  return installed;
}

export async function descriptorForConfig(
  packageName: string,
  deps: PluginLifecycleDeps,
): Promise<{ readonly descriptor: PluginDescriptor<unknown>; readonly version: string }> {
  const builtIn = deps.builtIns?.find((definition) => definition.packageName === packageName);
  if (builtIn !== undefined) return { descriptor: builtIn.descriptor, version: builtIn.version };
  const installed = await installedForConfig(packageName, deps);
  return { descriptor: await loadDescriptor(packageName, installed, deps), version: installed.version };
}
