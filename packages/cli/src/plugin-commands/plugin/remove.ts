import { loadPluginRegistry } from "@aio-proxy/core";
import { getLocale, m } from "@aio-proxy/i18n";
import { resolveLocalizedText } from "@aio-proxy/plugin-sdk";

import { entries, packageNameOf, removePlugin, requirePluginPackageName, usedPackageNames } from "./config-entry";
import {
  createCliPluginDiagnosticFactory,
  createDefaultPluginLifecycleDeps,
  type PluginLifecycleDeps,
  requireConfirmation,
} from "./deps";
import { BuiltInPluginRemovalError, PluginSecretPurgeConflictError, PluginTrustRejectedError } from "./errors";

export type PluginRemoveOptions = { readonly purgeSecrets?: boolean; readonly yes?: boolean };
export type PluginPruneOptions = { readonly yes?: boolean };
export type PluginListOptions = Record<string, never>;

export async function pluginList(_options: PluginListOptions, injected?: PluginLifecycleDeps): Promise<void> {
  const deps = injected ?? createDefaultPluginLifecycleDeps();
  try {
    const config = await deps.config.read();
    const enablements = entries(config).flatMap((entry) => {
      const packageName = packageNameOf(entry);
      return packageName === null ? [] : [{ packageName, ...(Array.isArray(entry) ? { options: entry[1] } : {}) }];
    });
    const configured = new Set(enablements.map((entry) => entry.packageName));
    const installed = new Set((await deps.listInstalledNpmPackages()).map((pkg) => pkg.packageName));
    const snapshot = await loadPluginRegistry({
      enablements,
      builtIns: deps.builtIns ?? [],
      diagnostics: createCliPluginDiagnosticFactory(),
      importPackage: deps.importPackage,
      logger: () => {},
      secrets: { readPluginSecret: (plugin) => deps.repository.readPluginSecret(plugin)?.value },
    });
    const names = [...new Set([...deps.builtInNames, ...configured])].sort();
    for (const packageName of names) {
      const loaded = snapshot.plugins.get(packageName);
      const state =
        loaded?.state.status === "failed"
          ? loaded.state.diagnostic.summary
          : deps.builtInNames.has(packageName)
            ? m.cli_plugin_state_builtin()
            : installed.has(packageName)
              ? m.cli_plugin_state_configured()
              : m.cli_plugin_state_not_installed();
      const label = loaded?.label === undefined ? undefined : resolveLocalizedText(loaded.label, getLocale());
      const description =
        loaded?.description === undefined ? undefined : resolveLocalizedText(loaded.description, getLocale());
      const identity = label === undefined ? packageName : `${label} (${packageName})`;
      deps.print(`${identity} ${state}${description === undefined ? "" : ` — ${description}`}`);
    }
  } finally {
    if (injected === undefined) deps.close?.();
  }
}

export async function pluginRemove(
  packageName: string,
  options: PluginRemoveOptions,
  injected?: PluginLifecycleDeps,
): Promise<void> {
  const deps = injected ?? createDefaultPluginLifecycleDeps();
  try {
    packageName = requirePluginPackageName(packageName);
    if (deps.builtInNames.has(packageName)) throw new BuiltInPluginRemovalError(packageName);
    await requireConfirmation(m.cli_plugin_remove_prompt({ plugin: packageName }), options, deps, packageName);
    const lifecycle = deps.withNpmPackageLifecycle ?? (async (_packageName, use) => use(async () => {}));
    await lifecycle(packageName, async (assertOwnership) => {
      await assertOwnership();
      await deps.config.replace((current) => removePlugin(current, packageName));
    });
    if (options.purgeSecrets === true) {
      try {
        await requireConfirmation(m.cli_plugin_purge_prompt({ plugin: packageName }), options, deps, packageName);
      } catch (error) {
        if (!(error instanceof PluginTrustRejectedError)) throw error;
        deps.print(m.cli_plugin_removed_secrets_retained({ plugin: packageName }));
        return;
      }
      await lifecycle(packageName, async (assertOwnership) => {
        await assertOwnership();
        await deps.config.transaction(async (current) => {
          if (entries(current).some((entry) => packageNameOf(entry) === packageName)) {
            throw new PluginSecretPurgeConflictError(packageName);
          }
          await assertOwnership();
          const snapshot = deps.repository.readPluginSecret(packageName);
          if (snapshot !== null && !deps.repository.deletePluginSecret(packageName, snapshot.revision)) {
            throw new PluginSecretPurgeConflictError(packageName);
          }
          return { next: current, result: undefined };
        });
      });
    }
    deps.print(
      options.purgeSecrets === true
        ? m.cli_plugin_removed_secrets_purged({ plugin: packageName })
        : m.cli_plugin_removed_secrets_retained({ plugin: packageName }),
    );
  } finally {
    if (injected === undefined) deps.close?.();
  }
}

export async function pluginPrune(options: PluginPruneOptions, injected?: PluginLifecycleDeps): Promise<void> {
  const deps = injected ?? createDefaultPluginLifecycleDeps();
  try {
    await requireConfirmation(m.cli_plugin_prune_prompt(), options, deps);
    const used = usedPackageNames(await deps.config.read());
    const unused = (await deps.listInstalledNpmPackages())
      .map((pkg) => pkg.packageName)
      .filter((packageName) => !used.has(packageName));
    let removed = 0;
    for (const packageName of unused) {
      if (
        await deps.removeNpmPackageCache(
          packageName,
          async () => !usedPackageNames(await deps.config.read()).has(packageName),
        )
      ) {
        removed += 1;
      }
    }
    deps.print(m.cli_plugin_pruned({ count: removed }));
  } finally {
    if (injected === undefined) deps.close?.();
  }
}
