import { m } from "@aio-proxy/i18n";
import { renderConfigSpec } from "../form";
import { requirePluginPackageName } from "./config-entry";
import { createDefaultPluginLifecycleDeps, type PluginLifecycleDeps, requireConfirmation } from "./deps";
import { commitPluginConfig, loadDescriptor, stageDescriptor } from "./descriptor";

export type PluginAddOptions = { readonly yes?: boolean; readonly registry?: string };

export async function pluginAdd(
  packageName: string,
  options: PluginAddOptions,
  injected?: PluginLifecycleDeps,
): Promise<void> {
  const deps = injected ?? createDefaultPluginLifecycleDeps();
  try {
    packageName = requirePluginPackageName(packageName);
    if (deps.builtInNames.has(packageName)) {
      deps.print(m.cli_plugin_already_builtin({ plugin: packageName }));
      return;
    }
    await requireConfirmation(m.cli_plugin_trust_prompt({ plugin: packageName }), options, deps, packageName);
    const installAndUse =
      deps.withInstalledNpmPackage ??
      (async (name, registry, use) => use(await deps.npmAdd(name, registry), async () => {}));
    await installAndUse(packageName, options.registry, async (installed, assertOwnership = async () => {}) => {
      const descriptor = await loadDescriptor(packageName, installed, deps);
      const rendered =
        descriptor.metadata.options === undefined
          ? { publicValues: {}, secrets: {} }
          : await renderConfigSpec(descriptor.metadata.options, { prompts: deps.prompts });
      await stageDescriptor(packageName, installed.version, descriptor, rendered.publicValues, rendered.secrets);
      const previousSecret = deps.repository.readPluginSecret(packageName);
      await commitPluginConfig(packageName, rendered.publicValues, rendered.secrets, previousSecret, deps, {
        assertPackageOwnership: assertOwnership,
      });
    });
    deps.print(m.cli_plugin_added({ plugin: packageName }));
  } finally {
    if (injected === undefined) deps.close?.();
  }
}
