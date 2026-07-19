import {
  AtomicConfigCommitUncertainError,
  ConfigSpecValidationError,
  findInstalledNpmPackage,
  loadPluginRegistry,
  type NpmPackageInfo,
  observedPromiseDeadline,
  PLUGIN_IMPORT_TIMEOUT_MS,
  type PluginSecretSnapshot,
  validateConfigSpec,
} from "@aio-proxy/core";
import { isPluginDescriptor, type PluginDescriptor } from "@aio-proxy/plugin-sdk";
import { pathToFileURL } from "node:url";

import type { PluginLifecycleDeps, SecretRepository } from "./deps";

import { cloneInertJson } from "../form";
import { entries, packageNameOf, pluginEntry, replacePlugin, sameJson } from "./config-entry";
import { createCliPluginDiagnosticFactory } from "./deps";
import {
  PluginConfigChangedError,
  PluginDescriptorInvalidError,
  PluginNotConfiguredError,
  PluginNotInstalledError,
  PluginSetupValidationError,
} from "./errors";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function descriptorFromModule(packageName: string, imported: unknown): PluginDescriptor<unknown> {
  if (!isRecord(imported)) throw new PluginDescriptorInvalidError(packageName);
  const descriptor = imported.default;
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

export async function loadDescriptor(
  packageName: string,
  installed: NpmPackageInfo,
  deps: PluginLifecycleDeps,
): Promise<PluginDescriptor<unknown>> {
  const attempt = crypto.randomUUID();
  const entrypoint = pathToFileURL(installed.entrypoint);
  entrypoint.searchParams.set("aio_proxy_cli_attempt", attempt);
  return descriptorFromModule(
    packageName,
    await observedPromiseDeadline(
      deps.importPackage({ packageName, version: installed.version, entrypoint: entrypoint.href, attempt }),
      {
        timeoutMs: deps.importTimeoutMs ?? PLUGIN_IMPORT_TIMEOUT_MS,
        timeoutError: () => new PluginDescriptorInvalidError(packageName),
      },
    ),
  );
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
  const snapshot = await loadPluginRegistry({
    enablements: [
      { packageName, ...(Object.keys(stagingPublicValues).length === 0 ? {} : { options: stagingPublicValues }) },
    ],
    builtIns: [{ packageName, version, descriptor }],
    diagnostics: createCliPluginDiagnosticFactory(),
    importPackage: async () => ({ default: descriptor }),
    logger: () => {},
    secrets: { readPluginSecret: () => stagingSecrets },
  });
  const state = snapshot.plugins.get(packageName)?.state;
  if (state?.status === "failed") throw new PluginSetupValidationError(packageName, state.diagnostic.summary);
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
      if (Object.hasOwn(options, "expectedEntry")) {
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
