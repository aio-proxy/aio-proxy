import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import {
  type AliasConfig,
  type AliasDimensions,
  type AliasSelectRow,
  type ModelId,
  type ModelRoute,
  type RouterConfig,
  flattenAliasVariants,
  matchAliasRows,
  modelRoutes as listedModelRoutes,
} from '@aio-proxy/types';

import { RouterModelCollisionError, RouterModelNotFoundError } from '../error';
import type { AiSdkProviderInstance } from '../provider/ai-sdk/index';
import type { ApiProviderInstance } from '../provider/api/index';
import { orderWeightedCandidates } from './weighted-order';

const DEFAULT_PRIORITY = 0;
const DEFAULT_WEIGHT = 1;

export type RoutableProvider = {
  readonly id: string;
  readonly enabled: boolean;
  readonly priority?: number | undefined;
  readonly weight?: number | undefined;
  readonly models?: readonly ModelId[] | undefined;
  readonly alias?: Readonly<Record<string, AliasConfig>> | undefined;
};

export type ProviderInstance = RoutableProvider &
  (
    | { readonly kind: ApiProviderInstance['kind'] }
    | { readonly kind: AiSdkProviderInstance['kind'] }
    | { readonly kind: string }
  );

export type RouterResolution<TProvider extends RoutableProvider = ProviderInstance> = {
  readonly provider: TProvider;
  readonly modelId: string;
};

export type RoutingValueSource = 'provider' | 'model';
export type RouterSelectionSource = 'provider_qualified' | 'deterministic_session' | 'weighted_random';
export type EffectiveCandidateRouting = {
  readonly priority: number;
  readonly weight: number;
  readonly prioritySource: RoutingValueSource;
  readonly weightSource: RoutingValueSource;
  readonly configurationIndex: number;
};
export type RouterCandidate<TProvider extends RoutableProvider = ProviderInstance> = RouterResolution<TProvider> & {
  readonly routing: EffectiveCandidateRouting;
  readonly selectionSource: RouterSelectionSource;
};
export type RouterCatalogCandidate<TProvider extends RoutableProvider = ProviderInstance> =
  RouterResolution<TProvider> & {
    readonly routing: EffectiveCandidateRouting;
  };

export type RouterOptions = {
  readonly models?: RouterConfig['models'];
  readonly random?: () => number;
};

export type RouterResolveOptions = {
  readonly session?: LogicalRequestContext['session'];
};

export type { ModelRoute };

type ConfiguredRouterRoute<TProvider extends RoutableProvider> = {
  readonly provider: TProvider;
  readonly config: AliasConfig;
  readonly rows: readonly AliasSelectRow[];
  readonly configurationIndex: number;
};

export class Router<TProvider extends RoutableProvider = ProviderInstance> {
  private readonly aliases = new Map<string, ConfiguredRouterRoute<TProvider>[]>();
  private readonly providerAliases = new Map<string, ConfiguredRouterRoute<TProvider>>();
  private readonly models: RouterConfig['models'];
  private readonly random: () => number;

  constructor(providers: readonly TProvider[], options: RouterOptions = {}) {
    this.models = options.models ?? {};
    this.random = options.random ?? Math.random;

    for (const [configurationIndex, provider] of providers.entries()) {
      if (provider.enabled === false) {
        continue;
      }

      for (const [alias, config] of Object.entries(provider.alias ?? {})) {
        this.addRoute(provider, alias, config, flattenAliasVariants(config.variants), configurationIndex);
      }
      for (const modelId of directModelIds(provider)) {
        this.addRoute(provider, modelId, { model: modelId, preserve: false }, [], configurationIndex);
      }
    }
  }

  resolve(
    model: string,
    dimensions: AliasDimensions = {},
    options: RouterResolveOptions = {},
  ): RouterCandidate<TProvider>[] {
    const qualified = this.providerAliases.get(model);
    if (qualified !== undefined) {
      return [this.toQualifiedCandidate(qualified, dimensions)];
    }

    const routes = this.aliases.get(model);
    if (routes === undefined) {
      throw new RouterModelNotFoundError(model);
    }

    const eligible = this.eligibleCandidates(routes, model, dimensions);
    if (eligible.length === 0) {
      throw new RouterModelNotFoundError(model);
    }

    const session = options.session;
    const useStable = session !== undefined && session.source !== 'generated';
    const draw = useStable
      ? (priority: number, drawIndex: number) => stableDraw(session.key, model, priority, drawIndex)
      : this.random;
    const selectionSource: RouterSelectionSource = useStable ? 'deterministic_session' : 'weighted_random';
    return orderWeightedCandidates(eligible, draw).map((candidate) => ({ ...candidate, selectionSource }));
  }

  catalogCandidates(model: string): RouterCatalogCandidate<TProvider>[] {
    const routes = this.aliases.get(model) ?? [];
    return this.eligibleCandidates(routes, model, {}).sort((left, right) => {
      if (left.routing.priority !== right.routing.priority) return right.routing.priority - left.routing.priority;
      if (left.routing.weight !== right.routing.weight) return right.routing.weight - left.routing.weight;
      return left.routing.configurationIndex - right.routing.configurationIndex;
    });
  }

  modelIds(): string[] {
    return [...this.aliases.keys()];
  }

  private addRoute(
    provider: TProvider,
    alias: string,
    config: AliasConfig,
    rows: readonly AliasSelectRow[],
    configurationIndex: number,
  ): void {
    const route = { provider, config, rows, configurationIndex };
    const providerAlias = `${provider.id}/${alias}`;
    const existingProviderRoute = this.providerAliases.get(providerAlias);

    if (existingProviderRoute !== undefined) {
      if (
        existingProviderRoute.provider === provider &&
        existingProviderRoute.config.preserve &&
        sameRouteTargets(existingProviderRoute.config, config)
      ) {
        return;
      }
      throw new RouterModelCollisionError(alias, existingProviderRoute.provider.id, provider.id);
    }

    this.providerAliases.set(providerAlias, route);
    const routes = this.aliases.get(alias) ?? [];
    routes.push(route);
    this.aliases.set(alias, routes);
  }

  private eligibleCandidates(
    routes: readonly ConfiguredRouterRoute<TProvider>[],
    model: string,
    dimensions: AliasDimensions,
  ): RouterCatalogCandidate<TProvider>[] {
    const candidates: RouterCatalogCandidate<TProvider>[] = [];
    for (const route of routes) {
      const candidate = this.toRoutedCandidate(route, model, dimensions, true);
      if (candidate.routing.weight > 0) candidates.push(candidate);
    }
    return candidates;
  }

  private toQualifiedCandidate(
    route: ConfiguredRouterRoute<TProvider>,
    dimensions: AliasDimensions,
  ): RouterCandidate<TProvider> {
    return {
      ...this.toRoutedCandidate(route, route.config.model, dimensions, false),
      selectionSource: 'provider_qualified',
    };
  }

  private toRoutedCandidate(
    route: ConfiguredRouterRoute<TProvider>,
    model: string,
    dimensions: AliasDimensions,
    applyPolicy: boolean,
  ): RouterCatalogCandidate<TProvider> {
    const { provider, config, rows, configurationIndex } = route;
    return {
      provider,
      modelId: matchAliasRows(rows, dimensions, { model: config.model, preserve: config.preserve }).model,
      routing: applyPolicy
        ? this.effectiveRouting(provider, model, configurationIndex)
        : providerDefaults(provider, configurationIndex),
    };
  }

  private effectiveRouting(provider: TProvider, model: string, configurationIndex: number): EffectiveCandidateRouting {
    const policy = Object.hasOwn(this.models, model) ? this.models[model] : undefined;
    const override =
      policy === undefined || !Object.hasOwn(policy.providers, provider.id) ? undefined : policy.providers[provider.id];
    const defaults = providerDefaults(provider, configurationIndex);
    if (override === undefined) return defaults;
    return {
      priority: override.priority ?? defaults.priority,
      weight: override.weight ?? defaults.weight,
      prioritySource: override.priority !== undefined ? 'model' : 'provider',
      weightSource: override.weight !== undefined ? 'model' : 'provider',
      configurationIndex,
    };
  }
}

function providerDefaults(provider: RoutableProvider, configurationIndex: number): EffectiveCandidateRouting {
  return {
    priority: provider.priority ?? DEFAULT_PRIORITY,
    weight: provider.weight ?? DEFAULT_WEIGHT,
    prioritySource: 'provider',
    weightSource: 'provider',
    configurationIndex,
  };
}

function stableDraw(sessionKey: string, model: string, priority: number, drawIndex: number): number {
  const hex = new Bun.CryptoHasher('sha256').update(`${sessionKey}\0${model}\0${priority}\0${drawIndex}`).digest('hex');
  return Number.parseInt(hex.slice(0, 13), 16) / 0x10_0000_0000_0000;
}

export function modelRoutes(provider: RoutableProvider): ModelRoute[] {
  return listedModelRoutes(provider);
}

function directModelIds(provider: RoutableProvider): string[] {
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

function preservedModelIds(provider: RoutableProvider): string[] {
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

function sameRouteTargets(left: AliasConfig, right: AliasConfig): boolean {
  const leftTargets = routeTargetModels(left);
  const rightTargets = routeTargetModels(right);
  return leftTargets.size === rightTargets.size && [...leftTargets].every((modelId) => rightTargets.has(modelId));
}

function routeTargetModels(config: AliasConfig): ReadonlySet<string> {
  return new Set([config.model, ...flattenAliasVariants(config.variants).map((row) => row.model)]);
}
