import { uniqWith } from 'es-toolkit/array';
import type { z } from 'zod';

import { flattenAliasVariants, isAliasVariantsObject } from '../alias-variant';
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

export function validateAliasTargets(provider: ProviderAliasTargets, ctx: z.RefinementCtx): void {
  if (provider.alias === undefined) {
    return;
  }

  validateAliasNames(provider.alias, ctx);
  // Absent AND empty both mean "no whitelist": the router exposes nothing directly
  // for either shape, and an alias-only provider (models: []) must stay saveable.
  const models = provider.models === undefined || provider.models.length === 0 ? undefined : new Set(provider.models);
  const preservedModels = preservedAliasModels(provider.alias);

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
    if (preservedModels.has(clientModel) && aliasTargetModels(config).some((model) => model !== clientModel)) {
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

/** Every model id an alias map asks to keep routable under its original id, defaults and variants alike. */
export function preservedAliasModels(alias: ProviderAlias): ReadonlySet<string> {
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

/** Every model id one alias can resolve to: its default plus every variant row's target. */
export function aliasTargetModels(config: AliasConfig): readonly string[] {
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

/** Enough of a provider to derive its client-facing routes; `enabled` is required so callers cannot pass a bare model list. */
type RoutableModelSource = {
  readonly enabled: boolean;
  readonly models?: readonly string[] | undefined;
  readonly alias?: ProviderAlias | undefined;
};

export type ModelRoute = {
  readonly alias: string;
  readonly modelId: string;
};

/**
 * Direct model ids first, then alias entries: this array's order is the client-facing listing order
 * (`clientModels`, `/v1/models`, the editor's exposure preview), not an implementation detail.
 * `uniqWith` keeps the first occurrence, so the dedup that used to skip the direct copy of a
 * preserved self-alias (`x -> x`) now skips the alias copy — one route either way.
 */
export function modelRoutes(provider: RoutableModelSource): ModelRoute[] {
  return uniqWith(
    [
      ...directModelIds(provider).map((modelId) => ({ alias: modelId, modelId })),
      ...Object.entries(provider.alias ?? {}).map(([alias, config]) => ({ alias, modelId: config.model })),
    ],
    (left, right) => left.alias === right.alias && left.modelId === right.modelId,
  );
}

export function directModelIds(provider: RoutableModelSource): string[] {
  const configuredModelIds = new Set<string>('models' in provider ? (provider.models ?? []) : []);
  const modelIds = new Set(configuredModelIds);

  for (const [alias, config] of Object.entries(provider.alias ?? {})) {
    modelIds.delete(alias);
    if (configuredModelIds.has(alias)) {
      continue;
    }
    if (!config.preserve) {
      modelIds.delete(config.model);
    }
    for (const target of flattenAliasVariants(config.variants)) {
      if (!target.preserve) {
        modelIds.delete(target.model);
      }
    }
  }

  for (const modelId of preservedModelIds(provider)) {
    modelIds.add(modelId);
  }
  return [...modelIds];
}

function preservedModelIds(provider: RoutableModelSource): string[] {
  const modelIds = new Set<string>();
  for (const config of Object.values(provider.alias ?? {})) {
    if (config.preserve) {
      modelIds.add(config.model);
    }
  }

  for (const config of Object.values(provider.alias ?? {})) {
    for (const target of flattenAliasVariants(config.variants)) {
      if (target.preserve) {
        const selfRoute = provider.alias?.[target.model];
        if (
          !modelIds.has(target.model) &&
          selfRoute !== undefined &&
          sameRouteTargets(selfRoute, { model: target.model, preserve: false })
        ) {
          continue;
        }
        modelIds.add(target.model);
      }
    }
  }
  return [...modelIds];
}

export function sameRouteTargets(left: AliasConfig, right: AliasConfig): boolean {
  // One derivation for both callers: a second copy here is what lets route shadowing drift away
  // from what validateAliasTargets considers an alias's targets.
  const leftTargets = new Set(aliasTargetModels(left));
  const rightTargets = new Set(aliasTargetModels(right));
  return leftTargets.size === rightTargets.size && [...leftTargets].every((modelId) => rightTargets.has(modelId));
}
