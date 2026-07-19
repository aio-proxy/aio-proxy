import type { PluginDescriptor } from "@aio-proxy/plugin-sdk";

import { m } from "@aio-proxy/i18n";

import { renderConfigSpec } from "../form";
import { entries, packageNameOf, publicOptionsOf, requirePluginPackageName, secretRecord } from "./config-entry";
import { createDefaultPluginLifecycleDeps, type PluginLifecycleDeps } from "./deps";
import {
  commitPluginConfig,
  descriptorForConfig,
  installedForConfig,
  loadDescriptor,
  stageDescriptor,
} from "./descriptor";
import { PluginNotConfiguredError } from "./errors";

export type PluginConfigOptions = { readonly clearSecret?: readonly string[] };

export async function pluginConfig(
  packageName: string,
  options: PluginConfigOptions,
  injected?: PluginLifecycleDeps,
): Promise<void> {
  const deps = injected ?? createDefaultPluginLifecycleDeps();
  try {
    packageName = requirePluginPackageName(packageName);
    const current = await deps.config.read();
    const currentEntry = entries(current).find((entry) => packageNameOf(entry) === packageName);
    if (currentEntry === undefined) throw new PluginNotConfiguredError(packageName);
    const configure = async (
      descriptor: PluginDescriptor<unknown>,
      version: string,
      assertPackageOwnership?: () => Promise<void>,
    ) => {
      const previousSecret = deps.repository.readPluginSecret(packageName);
      const rendered =
        descriptor.metadata.options === undefined
          ? { publicValues: {}, secrets: {} }
          : await renderConfigSpec(descriptor.metadata.options, {
              prompts: deps.prompts,
              currentPublicValues: publicOptionsOf(currentEntry),
              currentSecrets: secretRecord(previousSecret),
              ...(options.clearSecret === undefined ? {} : { clearSecrets: options.clearSecret }),
            });
      await stageDescriptor(packageName, version, descriptor, rendered.publicValues, rendered.secrets);
      await assertPackageOwnership?.();
      await commitPluginConfig(packageName, rendered.publicValues, rendered.secrets, previousSecret, deps, {
        expectedEntry: currentEntry,
        ...(assertPackageOwnership === undefined ? {} : { assertPackageOwnership }),
      });
    };
    if (deps.builtInNames.has(packageName)) {
      const { descriptor, version } = await descriptorForConfig(packageName, deps);
      await configure(descriptor, version);
    } else {
      const lifecycle = deps.withNpmPackageLifecycle ?? (async (_packageName, use) => use(async () => {}));
      await lifecycle(packageName, async (assertOwnership) => {
        await assertOwnership();
        const installed = await installedForConfig(packageName, deps);
        await assertOwnership();
        const descriptor = await loadDescriptor(packageName, installed, deps);
        await assertOwnership();
        await configure(descriptor, installed.version, assertOwnership);
      });
    }
    deps.print(m.cli_plugin_configured({ plugin: packageName }));
  } finally {
    if (injected === undefined) deps.close?.();
  }
}
