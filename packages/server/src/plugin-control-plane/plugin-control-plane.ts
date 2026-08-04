import {
  type BuiltInPluginDefinition,
  type DiagnosticFactory,
  type NpmPackageInfo,
  type PluginPackageImporter,
  type PluginRepository,
  removeNpmPackageCache,
  withInstalledNpmPackage,
  withNpmPackageLifecycle,
} from '@aio-proxy/core';
import type { DashboardPluginEditView, DashboardPluginOptionsMutation, DashboardPluginSummary } from '@aio-proxy/types';

import type { ConfigStore } from '../config-store';
import type { ProviderSnapshotLease } from '../runtime';
import { createPluginControlPlaneAccess } from './access';
import { installPlugin, type PluginInstallInput } from './install';
import { createPluginReads } from './read';
import { uninstallPlugin } from './uninstall';
import { updatePluginOptions } from './update-options';

export type PluginControlPlane = {
  readonly editView: (packageName: string) => Promise<DashboardPluginEditView>;
  readonly install: (input: PluginInstallInput) => Promise<void>;
  readonly summaries: () => readonly DashboardPluginSummary[];
  readonly uninstall: (packageName: string) => Promise<void>;
  readonly updateOptions: (mutation: DashboardPluginOptionsMutation) => Promise<DashboardPluginEditView>;
};

export type PluginControlPlaneOptions = {
  readonly acquireSnapshot: () => ProviderSnapshotLease;
  readonly builtIns: readonly BuiltInPluginDefinition[];
  readonly configStore: ConfigStore;
  readonly diagnostics: DiagnosticFactory;
  readonly importPackage: PluginPackageImporter;
  readonly repository: PluginRepository;
  readonly findInstalledNpmPackage?: (packageName: string) => Promise<NpmPackageInfo | null>;
  readonly removeNpmPackageCache?: typeof removeNpmPackageCache;
  readonly withInstalledNpmPackage?: typeof withInstalledNpmPackage;
  readonly withNpmPackageLifecycle?: typeof withNpmPackageLifecycle;
};

export function createPluginControlPlane(options: PluginControlPlaneOptions): PluginControlPlane {
  const access = createPluginControlPlaneAccess(options);
  const reads = createPluginReads({ access, configStore: options.configStore, repository: options.repository });
  const lifecycle = options.withNpmPackageLifecycle ?? withNpmPackageLifecycle;
  return {
    editView: reads.editView,
    async install(input) {
      await installPlugin(input, {
        builtInNames: access.builtInNames,
        configStore: options.configStore,
        diagnostics: options.diagnostics,
        importPackage: options.importPackage,
        withInstalledNpmPackage: options.withInstalledNpmPackage ?? withInstalledNpmPackage,
      });
    },
    summaries: reads.summaries,
    uninstall: (packageName) =>
      uninstallPlugin(packageName, {
        builtInNames: access.builtInNames,
        configStore: options.configStore,
        removeNpmPackageCache: options.removeNpmPackageCache ?? removeNpmPackageCache,
        repository: options.repository,
        withNpmPackageLifecycle: lifecycle,
      }),
    async updateOptions(mutation) {
      await updatePluginOptions(mutation, {
        access,
        configStore: options.configStore,
        diagnostics: options.diagnostics,
        repository: options.repository,
      });
      return reads.editView(mutation.packageName);
    },
  };
}
