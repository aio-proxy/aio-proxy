import {
  AtomicConfigCommitUncertainError,
  ConfigSpecValidationError,
  type DiagnosticFactory,
  type PluginRepository,
  PluginSetupInvalidError,
  stagePluginDescriptor,
} from '@aio-proxy/core';
import type { DashboardPluginOptionsMutation } from '@aio-proxy/types';

import { ConfigReloadRejectedError, type ConfigStore } from '../config-store';
import type { PluginControlPlaneAccess } from './access';
import { PluginControlPlaneError } from './errors';
import { candidateOptions, findPluginEntry, replacePlugin, revisionOf, sameValue } from './plugin-config';

export async function updatePluginOptions(
  mutation: DashboardPluginOptionsMutation,
  options: {
    readonly access: PluginControlPlaneAccess;
    readonly configStore: ConfigStore;
    readonly diagnostics: DiagnosticFactory;
    readonly repository: PluginRepository;
  },
): Promise<void> {
  if (options.configStore.file === undefined) throw new PluginControlPlaneError('config_unavailable', 409);
  try {
    await options.access.withDescriptor(mutation.packageName, async (descriptor, version, assertOwnership) => {
      const beforeConfig = await options.configStore.file!.read();
      const beforeEntry = findPluginEntry(beforeConfig, mutation.packageName)?.entry;
      if (beforeEntry === undefined && !options.access.builtInNames.has(mutation.packageName)) {
        throw new PluginControlPlaneError('plugin_not_found', 404);
      }
      const previousSecret = options.repository.readPluginSecret(mutation.packageName);
      if (revisionOf(beforeEntry, previousSecret?.revision ?? null) !== mutation.revision) {
        throw new PluginControlPlaneError('stale_revision', 409);
      }
      const candidate = candidateOptions(descriptor, mutation, previousSecret?.value);
      try {
        await assertOwnership();
        await stagePluginDescriptor({
          packageName: mutation.packageName,
          version,
          descriptor,
          publicValues: structuredClone(candidate.publicValues),
          secrets: structuredClone(candidate.secrets),
          diagnostics: options.diagnostics,
          logger: () => {},
        });
      } catch (error) {
        if (error instanceof PluginSetupInvalidError) {
          throw new PluginControlPlaneError(
            error.diagnostic.code === 'PLUGIN_OPTIONS_INVALID' ? 'options_invalid' : 'setup_failed',
            422,
          );
        }
        throw error;
      }

      let appliedRevision: number | null = null;
      try {
        await options.configStore.mutateConfig(async (current) => {
          await assertOwnership();
          const entry = findPluginEntry(current, mutation.packageName)?.entry;
          const latestSecret = options.repository.readPluginSecret(mutation.packageName);
          if (revisionOf(entry, latestSecret?.revision ?? null) !== mutation.revision) {
            throw new PluginControlPlaneError('stale_revision', 409);
          }
          if (!sameValue(latestSecret?.value ?? {}, candidate.secrets)) {
            appliedRevision = options.repository.writePluginSecret(
              mutation.packageName,
              latestSecret?.revision ?? null,
              candidate.secrets,
            ).revision;
          }
          return replacePlugin(current, mutation.packageName, candidate.publicValues);
        });
      } catch (error) {
        if (appliedRevision === null) {
          const latest = options.repository.readPluginSecret(mutation.packageName);
          if ((latest?.revision ?? null) !== (previousSecret?.revision ?? null)) {
            throw new PluginControlPlaneError('stale_revision', 409);
          }
        }
        if (appliedRevision !== null && !(error instanceof AtomicConfigCommitUncertainError)) {
          const latest = options.repository.readPluginSecret(mutation.packageName);
          if (latest?.revision === appliedRevision) {
            if (previousSecret === null) options.repository.deletePluginSecret(mutation.packageName, appliedRevision);
            else options.repository.writePluginSecret(mutation.packageName, appliedRevision, previousSecret.value);
          }
        }
        if (error instanceof ConfigReloadRejectedError) {
          throw new PluginControlPlaneError('reload_failed', 422);
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof ConfigSpecValidationError) throw new PluginControlPlaneError('descriptor_invalid', 422);
    throw error;
  }
}
