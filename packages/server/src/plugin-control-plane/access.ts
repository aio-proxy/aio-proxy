import {
  classifyInstalledPackage,
  findInstalledNpmPackage,
  NpmLockError,
  type BuiltInPluginDefinition,
  type NpmPackageInfo,
  type PluginPackageImporter,
  withNpmPackageLifecycle,
} from '@aio-proxy/core';
import type { PluginDescriptor } from '@aio-proxy/plugin-sdk';

import type { ProviderSnapshotLease } from '../runtime';
import type { Snapshot } from '../server-state/snapshot';
import { PluginControlPlaneError } from './errors';

export type PluginControlPlaneAccess = {
  readonly builtInNames: ReadonlySet<string>;
  readonly withDescriptor: <T>(
    packageName: string,
    use: (descriptor: PluginDescriptor<unknown>, version: string, assertOwnership: () => Promise<void>) => Promise<T>,
  ) => Promise<T>;
  readonly withSnapshot: <T>(read: (snapshot: Snapshot) => T) => T;
};

export function createPluginControlPlaneAccess(options: {
  readonly acquireSnapshot: () => ProviderSnapshotLease;
  readonly builtIns: readonly BuiltInPluginDefinition[];
  readonly importPackage: PluginPackageImporter;
  readonly withNpmPackageLifecycle?: typeof withNpmPackageLifecycle;
  readonly findInstalledNpmPackage?: (packageName: string) => Promise<NpmPackageInfo | null>;
}): PluginControlPlaneAccess {
  const builtIns = new Map(options.builtIns.map((definition) => [definition.packageName, definition]));
  const lifecycle = options.withNpmPackageLifecycle ?? withNpmPackageLifecycle;
  const findInstalled = options.findInstalledNpmPackage ?? findInstalledNpmPackage;
  return {
    builtInNames: new Set(builtIns.keys()),
    async withDescriptor(packageName, use) {
      const builtIn = builtIns.get(packageName);
      if (builtIn !== undefined) return use(builtIn.descriptor, builtIn.version, async () => {});
      try {
        return await lifecycle(packageName, async (assertOwnership) => {
          await assertOwnership();
          const installed = await findInstalled(packageName);
          if (installed === null) throw new PluginControlPlaneError('plugin_not_found', 404);
          const classification = await classifyInstalledPackage(packageName, installed, options.importPackage).catch(
            () => {
              throw new PluginControlPlaneError('descriptor_invalid', 422);
            },
          );
          if (classification.kind !== 'plugin') throw new PluginControlPlaneError('descriptor_invalid', 422);
          await assertOwnership();
          return use(classification.descriptor, installed.version, assertOwnership);
        });
      } catch (error) {
        if (error instanceof NpmLockError) throw new PluginControlPlaneError('npm_lock_failed', 423);
        throw error;
      }
    },
    withSnapshot(read) {
      const lease = options.acquireSnapshot();
      try {
        return read(lease.snapshot as Snapshot);
      } finally {
        lease.release();
      }
    },
  };
}
