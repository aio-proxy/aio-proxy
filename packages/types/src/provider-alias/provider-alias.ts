import type { z } from 'zod';

import type { AliasConfig } from '../common';
import { normalizeAliasName, normalizeVariantKey } from '../common';

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

type VariantValidation = {
  readonly alias: string;
  readonly models: ReadonlySet<string> | undefined;
  readonly ctx: z.RefinementCtx;
};

export function validateAliasTargets(provider: ProviderAliasTargets, ctx: z.RefinementCtx): void {
  if (provider.alias === undefined) {
    return;
  }

  validateAliasNames(provider.alias, ctx);
  // Absent AND empty both mean "no whitelist": the router exposes nothing directly
  // for either shape, and an alias-only provider (models: []) must stay saveable.
  const models = provider.models === undefined || provider.models.length === 0 ? undefined : new Set(provider.models);
  const preservedModels = collectPreservedModels(provider.alias);

  for (const [alias, config] of Object.entries(provider.alias)) {
    if (models !== undefined && !models.has(config.model)) {
      ctx.addIssue({
        code: 'custom',
        message: `Alias target "${config.model}" is not listed in models`,
        path: ['alias', alias, 'model'],
      });
    }

    validateVariants(config, { alias, models, ctx });
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

function validateVariants(config: AliasConfig, { alias, models, ctx }: VariantValidation): void {
  const names = new Set<string>();
  for (const [variant, target] of Object.entries(config.variants ?? {})) {
    const normalized = normalizeVariantKey(variant);
    if (normalized === '' || names.has(normalized)) {
      ctx.addIssue({
        code: 'custom',
        message: normalized === '' ? 'Variant name cannot be empty' : `Duplicate variant name "${normalized}"`,
        path: ['alias', alias, 'variants', variant],
      });
    }
    names.add(normalized);

    if (models !== undefined && !models.has(target.model)) {
      ctx.addIssue({
        code: 'custom',
        message: `Alias variant target "${target.model}" is not listed in models`,
        path: ['alias', alias, 'variants', variant, 'model'],
      });
    }
  }
}

function collectPreservedModels(alias: ProviderAlias): ReadonlySet<string> {
  const models = new Set<string>();
  for (const config of Object.values(alias)) {
    if (config.preserve) {
      models.add(config.model);
    }
    for (const target of Object.values(config.variants ?? {})) {
      if (target.preserve) {
        models.add(target.model);
      }
    }
  }
  return models;
}

function targetModels(config: AliasConfig): readonly string[] {
  return [config.model, ...Object.values(config.variants ?? {}).map((target) => target.model)];
}

function normalizeAliasKeys(alias: ProviderAlias): ProviderAlias {
  return Object.fromEntries(
    Object.entries(alias).map(([name, config]) => [
      normalizeAliasName(name),
      config.variants === undefined
        ? config
        : {
            ...config,
            variants: Object.fromEntries(
              Object.entries(config.variants).map(([variant, target]) => [normalizeVariantKey(variant), target]),
            ),
          },
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
