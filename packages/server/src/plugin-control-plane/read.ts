import { ConfigSpecValidationError, type PluginRepository, validateConfigSpec } from '@aio-proxy/core';
import {
  type DashboardPluginEditView,
  DashboardPluginEditViewSchema,
  type DashboardPluginSummary,
} from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import type { ConfigStore } from '../config-store';
import { dashboardOAuthForm } from '../dashboard-routes/oauth-capabilities';
import type { PluginControlPlaneAccess } from './access';
import { PluginControlPlaneError } from './errors';
import { findPluginEntry, publicOptionsOf, revisionOf } from './plugin-config';

const JsonValueSchema = z.json();

export function createPluginReads(options: {
  readonly access: PluginControlPlaneAccess;
  readonly configStore: ConfigStore;
  readonly repository: PluginRepository;
}): {
  readonly editView: (packageName: string) => Promise<DashboardPluginEditView>;
  readonly summaries: () => readonly DashboardPluginSummary[];
} {
  const summaries = (): readonly DashboardPluginSummary[] =>
    options.access.withSnapshot((snapshot) => {
      const enabled = new Set(snapshot.config.plugins.map(({ packageName }) => packageName));
      return [...snapshot.plugins.plugins.values()]
        .map((plugin) => ({
          builtin: plugin.builtIn,
          enabled: enabled.has(plugin.packageName),
          hasOptions: plugin.hasOptions === true,
          packageName: plugin.packageName,
          ...(plugin.label === undefined ? {} : { label: plugin.label }),
          state: plugin.state,
          ...(plugin.version === undefined ? {} : { version: plugin.version }),
        }))
        .sort((left, right) => left.packageName.localeCompare(right.packageName));
    });

  const editView = async (packageName: string): Promise<DashboardPluginEditView> => {
    const exists = options.access.withSnapshot((snapshot) => snapshot.plugins.plugins.has(packageName));
    if (!exists && !options.access.builtInNames.has(packageName)) {
      throw new PluginControlPlaneError('plugin_not_found', 404);
    }
    if (options.configStore.file === undefined) throw new PluginControlPlaneError('config_unavailable', 409);
    try {
      return await options.access.withDescriptor(packageName, async (descriptor) => {
        const current = await options.configStore.file!.read();
        const entry = findPluginEntry(current, packageName)?.entry;
        const secret = options.repository.readPluginSecret(packageName);
        const validated =
          descriptor.metadata.options === undefined ? undefined : validateConfigSpec(descriptor.metadata.options);
        const secretKeys = validated?.secretKeys ?? new Set<string>();
        const formKeys = new Set(validated?.spec.form.map((field) => field.key));
        const publicValues = Object.fromEntries(
          Object.entries(publicOptionsOf(entry)).filter(
            ([key, value]) => !secretKeys.has(key) && formKeys.has(key) && JsonValueSchema.safeParse(value).success,
          ),
        );
        const configuredSecrets = new Set(
          isPlainObject(secret?.value) ? Object.keys(secret.value).filter((key) => secretKeys.has(key)) : [],
        );
        return DashboardPluginEditViewSchema.parse({
          packageName,
          form: dashboardOAuthForm(validated?.spec.form ?? [], configuredSecrets),
          publicValues,
          revision: revisionOf(entry, secret?.revision ?? null),
        });
      });
    } catch (error) {
      if (error instanceof PluginControlPlaneError) throw error;
      if (error instanceof ConfigSpecValidationError) throw new PluginControlPlaneError('descriptor_invalid', 422);
      throw error;
    }
  };

  return { editView, summaries };
}
