import type { z } from 'zod';

import { flattenAliasVariants, isAliasVariantsObject } from './alias-variant';
import type { AliasConfig } from './common';
import { normalizeAliasName, normalizeVariantKey } from './common';

export type ProviderAlias = Readonly<Record<string, AliasConfig>>;

type ProviderWithAlias = { readonly alias?: ProviderAlias | undefined };

export function normalizeProviderAliasKeys<T extends ProviderWithAlias>(provider: T): T {
  if (provider.alias === undefined) return provider;
  return { ...provider, alias: normalizeAliasKeys(provider.alias) };
}

export function normalizeProviderAlias<T extends ProviderWithAlias>(provider: T): T {
  const normalized = normalizeProviderAliasKeys(provider);
  if (normalized.alias === undefined) return normalized;
  const alias = normalizeAliasPreserve(normalized.alias);
  return alias === normalized.alias ? normalized : { ...normalized, alias };
}

type ProviderAliasTargets = {
  readonly models?: readonly string[] | undefined;
  readonly alias?: ProviderAlias | undefined;
};

export function validateAliasTargets(provider: ProviderAliasTargets, ctx: z.RefinementCtx): void {
  if (provider.alias === undefined) {
    return;
  }

  validateAliasNames(provider.alias, ctx);
  const models = provider.models === undefined ? undefined : new Set(provider.models);
  const preservedModels = collectPreservedModels(provider.alias);

  for (const [alias, config] of Object.entries(provider.alias)) {
    if (models !== undefined && !models.has(config.model)) {
      ctx.addIssue({
        code: 'custom',
        message: `Alias target "${config.model}" is not listed in models`,
        path: ['alias', alias, 'model'],
      });
    }

    if (models !== undefined) {
      eachVariantTarget(config, (model, path) => {
        if (!models.has(model)) {
          ctx.addIssue({
            code: 'custom',
            message: `Alias variant target "${model}" is not listed in models`,
            path: ['alias', alias, ...path],
          });
        }
      });
    }

    const clientModel = normalizeAliasName(alias);
    if (preservedModels.has(clientModel) && targetModels(config).some((model) => model !== clientModel)) {
      ctx.addIssue({
        code: 'custom',
        message: `Alias "${clientModel}" conflicts with a preserved original model id`,
        path: ['alias', alias],
      });
    }
  }
}

function validateAliasNames(alias: ProviderAlias, ctx: z.RefinementCtx): void {
  const names = new Set<string>();
  for (const name of Object.keys(alias)) {
    const normalized = normalizeAliasName(name);
    if (normalized === '' || names.has(normalized)) {
      ctx.addIssue({
        code: 'custom',
        message: normalized === '' ? 'Alias name cannot be empty' : `Duplicate alias name "${normalized}"`,
        path: ['alias', name],
      });
    }
    names.add(normalized);
  }
}

// Flattening drops object variant keys, so membership issues walk the raw shape to keep Zod paths exact.
function eachVariantTarget(config: AliasConfig, visit: (model: string, path: Array<string | number>) => void): void {
  const variants = config.variants;
  if (variants === undefined) return;
  if (Array.isArray(variants)) {
    for (const [index, row] of variants.entries()) visit(row.model, ['variants', index, 'model']);
    return;
  }
  for (const [key, target] of Object.entries(variants)) visit(target.model, ['variants', key, 'model']);
}

function collectPreservedModels(alias: ProviderAlias): ReadonlySet<string> {
  const models = new Set<string>();
  for (const config of Object.values(alias)) {
    if (config.preserve) {
      models.add(config.model);
    }
    for (const row of flattenAliasVariants(config.variants)) {
      if (row.preserve) {
        models.add(row.model);
      }
    }
  }
  return models;
}

function targetModels(config: AliasConfig): readonly string[] {
  return [config.model, ...flattenAliasVariants(config.variants).map((row) => row.model)];
}

function normalizeAliasKeys(alias: ProviderAlias): ProviderAlias {
  return Object.fromEntries(
    Object.entries(alias).map(([name, config]) => [
      normalizeAliasName(name),
      isAliasVariantsObject(config.variants)
        ? {
            ...config,
            variants: Object.fromEntries(
              Object.entries(config.variants).map(([variant, target]) => [normalizeVariantKey(variant), target]),
            ),
          }
        : config,
    ]),
  );
}

function normalizeAliasPreserve(alias: ProviderAlias): ProviderAlias {
  let changed = false;
  const normalized: Record<string, ProviderAlias[string]> = {};
  for (const [clientModel, config] of Object.entries(alias)) {
    const selfAlias = alias[config.model];
    if (config.preserve && clientModel !== config.model && selfAlias?.model === config.model) {
      normalized[clientModel] = { ...config, preserve: false };
      changed = true;
      continue;
    }
    normalized[clientModel] = config;
  }
  return changed ? normalized : alias;
}
