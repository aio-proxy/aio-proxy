import {
  classifyInstalledPackage,
  ConfigSpecValidationError,
  InstalledPackageInvalidError,
  NpmInstallError,
  NpmLockError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
  type DiagnosticFactory,
  type PluginPackageImporter,
  PluginSetupInvalidError,
  stagePluginDescriptor,
  type withInstalledNpmPackage,
} from '@aio-proxy/core';

import { ConfigReloadRejectedError, type ConfigStore } from '../config-store';
import { PluginControlPlaneError } from './errors';
import { findPluginEntry, replacePlugin } from './plugin-config';

export type PluginInstallInput = {
  readonly packageName: string;
  readonly registry?: string | undefined;
  readonly confirmed?: boolean | undefined;
};

export async function installPlugin(
  input: PluginInstallInput,
  options: {
    readonly builtInNames: ReadonlySet<string>;
    readonly configStore: ConfigStore;
    readonly diagnostics: DiagnosticFactory;
    readonly importPackage: PluginPackageImporter;
    readonly withInstalledNpmPackage: typeof withInstalledNpmPackage;
  },
): Promise<void> {
  if (options.configStore.file === undefined) throw new PluginControlPlaneError('config_unavailable', 409);
  if (input.confirmed !== true) throw new PluginControlPlaneError('confirmation_required', 400);
  if (options.builtInNames.has(input.packageName)) throw new PluginControlPlaneError('already_installed', 409);
  const before = await options.configStore.file.read();
  if (findPluginEntry(before, input.packageName) !== undefined) {
    throw new PluginControlPlaneError('already_installed', 409);
  }

  try {
    await options.withInstalledNpmPackage(input.packageName, input.registry, async (installed, assertOwnership) => {
      await assertOwnership();
      const classification = await classifyInstalledPackage(input.packageName, installed, options.importPackage);
      if (classification.kind !== 'plugin') throw new PluginControlPlaneError('descriptor_invalid', 422);
      await stagePluginDescriptor({
        packageName: input.packageName,
        version: installed.version,
        descriptor: classification.descriptor,
        publicValues: {},
        secrets: {},
        diagnostics: options.diagnostics,
        logger: () => {},
      });
      await assertOwnership();
      await options.configStore.mutateConfig(async (current) => {
        await assertOwnership();
        if (findPluginEntry(current, input.packageName) !== undefined) {
          throw new PluginControlPlaneError('already_installed', 409);
        }
        return replacePlugin(current, input.packageName, {});
      });
    });
  } catch (error) {
    if (error instanceof PluginControlPlaneError) throw error;
    if (error instanceof PluginSetupInvalidError) {
      throw new PluginControlPlaneError(
        error.diagnostic.code === 'PLUGIN_OPTIONS_INVALID' ? 'options_invalid' : 'setup_failed',
        422,
      );
    }
    if (error instanceof InstalledPackageInvalidError || error instanceof ConfigSpecValidationError) {
      throw new PluginControlPlaneError('descriptor_invalid', 422);
    }
    if (error instanceof ConfigReloadRejectedError) throw new PluginControlPlaneError('reload_failed', 422);
    if (error instanceof NpmLockError) throw new PluginControlPlaneError('npm_lock_failed', 423);
    if (error instanceof NpmInstallError) throw new PluginControlPlaneError('npm_install_failed', 502);
    if (error instanceof NpmPackageEntrypointError || error instanceof NpmPackageJsonError) {
      throw new PluginControlPlaneError('package_invalid', 502);
    }
    if (error instanceof NpmPackageNameError) throw new PluginControlPlaneError('package_invalid', 400);
    throw error;
  }
}
