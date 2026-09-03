import { uniqWith } from 'es-toolkit/array';
import type { z } from 'zod';

import { flattenAliasVariants } from '../alias-variant';
import type { AliasConfig } from '../common';
import { normalizeAliasName } from '../common';
import { INHERIT_OFF_KEY, isAuthoredAliasConfig, type AuthoredOAuthAlias } from './oauth-alias';

export type ProviderAlias = Readonly<Record<string, AliasConfig>>;

type AnyAlias = ProviderAlias | AuthoredOAuthAlias;

type ProviderWithAlias = { readonly alias?: AnyAlias | undefined };

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
  readonly kind?: string | undefined;
  readonly models?: readonly string[] | undefined;
  readonly excludedModels?: readonly string[] | undefined;
  readonly alias?: AnyAlias | undefined;
};

export function validateAliasTargets(provider: ProviderAliasTargets, ctx: z.RefinementCtx): void {
  if (provider.alias === undefined) {
    return;
  }

  validateAliasNames(provider.alias, ctx);

  if (provider.kind === 'oauth') {
    validateOAuthAliasTargets(provider.alias, provider.excludedModels, ctx);
    return;
  }

  validateConfiguredAliasTargets(provider.alias, provider.models, ctx);
}

function validateOAuthAliasTargets(
  alias: AnyAlias,
  excludedModels: readonly string[] | undefined,
  ctx: z.RefinementCtx,
): void {
  const excluded = excludedModels === undefined || excludedModels.length === 0 ? undefined : new Set(excludedModels);
  const configs = authoredConfigs(alias);
  const preservedModels = preservedAliasModels(configs);

  for (const [aliasName, value] of Object.entries(alias)) {
    if (!Object.hasOwn(alias, aliasName)) continue;
    if (value === false || normalizeAliasName(aliasName) === INHERIT_OFF_KEY) continue;
    if (!isAuthoredAliasConfig(value)) continue;
    if (excluded !== undefined && excluded.has(value.model)) {
      ctx.addIssue({
        code: 'custom',
        message: `Alias target "${value.model}" is listed in excludedModels`,
        path: ['alias', aliasName, 'model'],
      });
    }
    if (excluded !== undefined) {
      eachVariantTarget(value, (model, path) => {
        if (excluded.has(model)) {
          ctx.addIssue({
            code: 'custom',
            message: `Alias variant target "${model}" is listed in excludedModels`,
            path: ['alias', aliasName, ...path],
          });
        }
      });
    }
    reportPreservedConflict(aliasName, value, preservedModels, ctx);
  }
}

function validateConfiguredAliasTargets(
  alias: AnyAlias,
  models: readonly string[] | undefined,
  ctx: z.RefinementCtx,
): void {
  // Absent AND empty both mean "no whitelist": the router exposes nothing directly
  // for either shape, and an alias-only provider (models: []) must stay saveable.
  const allowed = models === undefined || models.length === 0 ? undefined : new Set(models);
  const configs = authoredConfigs(alias);
  const preservedModels = preservedAliasModels(configs);

  for (const [aliasName, value] of Object.entries(alias)) {
    if (!Object.hasOwn(alias, aliasName)) continue;
    const name = normalizeAliasName(aliasName);
    if (value === false || name === INHERIT_OFF_KEY) {
      ctx.addIssue({
        code: 'custom',
        message:
          name === INHERIT_OFF_KEY
            ? 'Reserved alias key "*" is only valid on OAuth providers'
            : 'Alias hide (`false`) is only valid on OAuth providers',
        path: ['alias', aliasName],
      });
      continue;
    }
    if (!isAuthoredAliasConfig(value)) continue;
    if (allowed !== undefined && !allowed.has(value.model)) {
      ctx.addIssue({
        code: 'custom',
        message: `Alias target "${value.model}" is not listed in models`,
        path: ['alias', aliasName, 'model'],
      });
    }
    if (allowed !== undefined) {
      eachVariantTarget(value, (model, path) => {
        if (!allowed.has(model)) {
          ctx.addIssue({
            code: 'custom',
            message: `Alias variant target "${model}" is not listed in models`,
            path: ['alias', aliasName, ...path],
          });
        }
      });
    }
    reportPreservedConflict(aliasName, value, preservedModels, ctx);
  }
}

function authoredConfigs(alias: AnyAlias): ProviderAlias {
  return Object.fromEntries(
    Object.entries(alias).filter(
      (entry): entry is [string, AliasConfig] =>
        Object.hasOwn(alias, entry[0]) &&
        isAuthoredAliasConfig(entry[1]) &&
        normalizeAliasName(entry[0]) !== INHERIT_OFF_KEY,
    ),
  );
}

function reportPreservedConflict(
  aliasName: string,
  config: AliasConfig,
  preservedModels: ReadonlySet<string>,
  ctx: z.RefinementCtx,
): void {
  const clientModel = normalizeAliasName(aliasName);
  if (preservedModels.has(clientModel) && aliasTargetModels(config).some((model) => model !== clientModel)) {
    ctx.addIssue({
      code: 'custom',
      message: `Alias "${clientModel}" conflicts with a preserved original model id`,
      path: ['alias', aliasName],
    });
  }
}

function validateAliasNames(alias: AnyAlias, ctx: z.RefinementCtx): void {
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

function eachVariantTarget(config: AliasConfig, visit: (model: string, path: Array<string | number>) => void): void {
  for (const [index, row] of flattenAliasVariants(config.variants).entries()) {
    visit(row.model, ['variants', index, 'model']);
  }
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

/**
 * The alias entries a `models` whitelist can actually route. Absent and empty both mean "no
 * whitelist", the same rule `validateAliasTargets` applies, and this filter exists to keep that
 * refinement satisfiable: it rejects per provider, not per alias, so one entry aimed outside the
 * whitelist invalidates the whole provider.
 *
 * Entries drop whole, never half — a surviving variant target outside the whitelist is rejected just
 * as hard as a default one.
 */
export function exposedAliases(alias: ProviderAlias, models: readonly string[] | undefined): ProviderAlias {
  if (models === undefined || models.length === 0) return alias;
  const allowed = new Set(models);
  return Object.fromEntries(
    Object.entries(alias).filter(([, config]) => aliasTargetModels(config).every((model) => allowed.has(model))),
  );
}

function normalizeAliasKeys(alias: AnyAlias): AnyAlias {
  return Object.fromEntries(Object.entries(alias).map(([name, config]) => [normalizeAliasName(name), config]));
}

function normalizeAliasPreserve(alias: AnyAlias): AnyAlias {
  let changed = false;
  const normalized: Record<string, AnyAlias[string]> = {};
  for (const [clientModel, config] of Object.entries(alias)) {
    if (config === false) {
      normalized[clientModel] = false;
      continue;
    }
    const selfAlias = alias[config.model];
    if (
      config.preserve &&
      clientModel !== config.model &&
      selfAlias !== undefined &&
      selfAlias !== false &&
      selfAlias.model === config.model
    ) {
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
 * `Router` walks the same two sources in the opposite order on purpose — see the comment in its
 * constructor — so do not unify the two.
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
    if (!config.preserve && !configuredModelIds.has(alias)) {
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
