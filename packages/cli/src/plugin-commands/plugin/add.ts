import { m } from '@aio-proxy/i18n';

import { renderConfigSpec } from '../form';
import { requirePluginPackageName } from './config-entry';
import {
  beginPluginSession,
  createDefaultPluginLifecycleDeps,
  type PluginLifecycleDeps,
  reportLine,
  requireConfirmation,
} from './deps';
import { classifyInstalledPackage, commitPluginConfig, stageDescriptor } from './descriptor';

export type PluginAddOptions = { readonly yes?: boolean; readonly registry?: string };

export async function pluginAdd(
  packageName: string,
  options: PluginAddOptions,
  injected?: PluginLifecycleDeps,
): Promise<void> {
  const deps = injected ?? createDefaultPluginLifecycleDeps();
  packageName = requirePluginPackageName(packageName);
  if (deps.builtInNames.has(packageName)) {
    deps.print(m['cli.plugin.already_builtin']({ plugin: packageName }));
    return;
  }
  const session = beginPluginSession(deps, m['cli.ui.title_plugin_add']());
  let failure: unknown;
  try {
    await requireConfirmation(
      m['cli.plugin.trust_prompt']({ plugin: packageName }),
      options,
      deps,
      packageName,
      session,
    );
    const installAndUse =
      deps.withInstalledNpmPackage ??
      (async (name, registry, use) => use(await deps.npmAdd(name, registry), async () => {}));
    const classification = await installAndUse(packageName, options.registry, async (installed, assertOwnership) => {
      const classified = await classifyInstalledPackage(packageName, installed, deps);
      // An AI SDK provider package has no descriptor to render or enable; installing it
      // into the cache is the whole job, and it is referenced from a `kind: ai-sdk`
      // provider in config, not the `plugins` list. Never write config or secrets for it.
      if (classified.kind === 'ai-sdk-provider') return classified;
      const descriptor = classified.descriptor;
      const rendered =
        descriptor.metadata.options === undefined
          ? { publicValues: {}, secrets: {} }
          : await renderConfigSpec(descriptor.metadata.options, { prompts: session?.prompts ?? deps.prompts });
      await stageDescriptor(packageName, installed.version, descriptor, rendered.publicValues, rendered.secrets);
      const previousSecret = deps.repository.readPluginSecret(packageName);
      await commitPluginConfig(packageName, rendered.publicValues, rendered.secrets, previousSecret, deps, {
        assertPackageOwnership: assertOwnership,
      });
      return classified;
    });
    reportLine(
      deps,
      session,
      classification.kind === 'ai-sdk-provider'
        ? m['cli.provider.package_installed']({ package: packageName })
        : m['cli.plugin.added']({ plugin: packageName }),
    );
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    session?.close(failure);
    if (injected === undefined) deps.close?.();
  }
}
