import { digestProviderEntry, resolveConfigTemplates, validateConfigSpec } from '@aio-proxy/core';
import type { PluginDescriptor } from '@aio-proxy/plugin-sdk';
import { type DashboardPluginOptionsMutation, PluginPackageNameSchema } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { PluginControlPlaneError } from './errors';

export function pluginEntries(config: Readonly<Record<string, unknown>>): readonly unknown[] {
  return Array.isArray(config['plugins']) ? config['plugins'] : [];
}

export function packageNameOf(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  return Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : undefined;
}

export function normalizedPackageName(value: unknown): string | undefined {
  const parsed = PluginPackageNameSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function publicOptionsOf(entry: unknown): Readonly<Record<string, unknown>> {
  return Array.isArray(entry) && isPlainObject(entry[1]) ? entry[1] : {};
}

export function findPluginEntry(
  config: Readonly<Record<string, unknown>>,
  packageName: string,
): { readonly entry: unknown; readonly index: number } | undefined {
  const entries = pluginEntries(config);
  const resolved = resolveConfigTemplates(entries);
  if (!Array.isArray(resolved)) return undefined;
  const target = normalizedPackageName(packageName);
  if (target === undefined) return undefined;
  const index = resolved.findIndex((entry) => normalizedPackageName(packageNameOf(entry)) === target);
  return index < 0 ? undefined : { entry: entries[index], index };
}

export function revisionOf(entry: unknown, secretRevision: number | null): string {
  return `sha256:${digestProviderEntry({ entry: entry ?? null, secretRevision })}`;
}

export function replacePlugin(
  config: Record<string, unknown>,
  packageName: string,
  publicValues: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const entries = pluginEntries(config);
  const match = findPluginEntry(config, packageName);
  const reference = packageNameOf(match?.entry) ?? packageName;
  const entry = Object.keys(publicValues).length === 0 ? reference : [reference, publicValues];
  return {
    ...config,
    plugins:
      match === undefined
        ? [...entries, entry]
        : entries.map((current, offset) => (offset === match.index ? entry : current)),
  };
}

export function candidateOptions(
  descriptor: PluginDescriptor<unknown>,
  mutation: DashboardPluginOptionsMutation,
  previousSecret: unknown,
): { readonly publicValues: Record<string, unknown>; readonly secrets: Record<string, unknown> } {
  const validated =
    descriptor.metadata.options === undefined ? undefined : validateConfigSpec(descriptor.metadata.options);
  const fields = new Map(validated?.spec.form.map((field) => [field.key, field]));
  if (
    Object.keys(mutation.publicValues).some(
      (key) => fields.get(key)?.type === undefined || fields.get(key)?.type === 'secret',
    ) ||
    Object.keys(mutation.secretValues).some((key) => fields.get(key)?.type !== 'secret') ||
    mutation.clearSecretKeys.some((key) => fields.get(key)?.type !== 'secret') ||
    mutation.clearSecretKeys.some((key) => Object.hasOwn(mutation.secretValues, key))
  ) {
    throw new PluginControlPlaneError('options_invalid', 422);
  }
  const secretKeys = validated?.secretKeys ?? new Set<string>();
  const retainedEntries = isPlainObject(previousSecret)
    ? Object.entries(previousSecret).filter(([key]) => secretKeys.has(key))
    : [];
  const secrets = Object.fromEntries([...retainedEntries, ...Object.entries(mutation.secretValues)]);
  for (const key of mutation.clearSecretKeys) delete secrets[key];
  return { publicValues: mutation.publicValues, secrets };
}

export function sameValue(left: unknown, right: unknown): boolean {
  return digestProviderEntry(left) === digestProviderEntry(right);
}
