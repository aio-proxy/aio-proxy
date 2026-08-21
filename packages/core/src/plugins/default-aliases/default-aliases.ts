import type { ModelCatalog, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { AliasConfigSchema, flattenAliasVariants, type ProviderAlias } from '@aio-proxy/types';
import { z } from 'zod';

export function assertAliasTargetsInCatalog(suggestions: unknown, catalog: ModelCatalog): ProviderAlias {
  const models = new Set(catalog.language.map(({ id }) => id));
  const parsed = z.record(z.string().min(1), AliasConfigSchema).parse(suggestions);
  for (const [alias, config] of Object.entries(parsed)) {
    const modelsToCheck = [config.model, ...flattenAliasVariants(config.variants).map((row) => row.model)];
    for (const model of modelsToCheck) {
      if (!models.has(model)) {
        throw new Error(`Plugin default alias target ${alias} -> ${model} is not in the initial catalog`);
      }
    }
  }
  return parsed;
}

export function insertMissingAliases(base: ProviderAlias, suggestions: ProviderAlias): ProviderAlias {
  let next: Record<string, ProviderAlias[string]> | undefined;
  for (const [key, suggestion] of Object.entries(suggestions)) {
    if (Object.hasOwn(base, key)) continue;
    next ??= { ...base };
    next[key] = suggestion;
  }
  return next ?? base;
}

export function validatedDefaultAliases(adapter: OAuthAdapter, catalog: ModelCatalog): ProviderAlias | undefined {
  const raw = adapter.catalog.defaultAliases?.(catalog);
  if (raw === undefined) return undefined;
  return assertAliasTargetsInCatalog(raw, catalog);
}
