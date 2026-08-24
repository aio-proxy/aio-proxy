import type { ModelCatalog, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { AliasConfigSchema, exposedAliases, flattenAliasVariants, type ProviderAlias } from '@aio-proxy/types';
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

/**
 * Insert only the keys `base` does not have, and only the ones the provider's `models` whitelist can
 * route. The whitelist filter belongs here rather than at each caller: `assertAliasTargetsInCatalog`
 * checks the catalog, which is a superset of the whitelist, so an unfiltered insert writes an alias
 * that `validateAliasTargets` rejects — and that rejection drops the *whole* provider out of routing,
 * including its previously valid aliases, on an unattended background refresh.
 *
 * `models` is `unknown` because both callers read it off a `PlainRecord` config entry. A non-array is
 * treated as no whitelist: such an entry cannot parse as a provider at all, so there is nothing this
 * filter could keep valid.
 */
export function insertMissingAliases(base: ProviderAlias, suggestions: ProviderAlias, models: unknown): ProviderAlias {
  const whitelist = Array.isArray(models) ? models.filter((id): id is string => typeof id === 'string') : undefined;
  let next: Record<string, ProviderAlias[string]> | undefined;
  for (const [key, suggestion] of Object.entries(exposedAliases(suggestions, whitelist))) {
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
