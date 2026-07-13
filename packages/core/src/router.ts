import { type AliasConfig, type Provider as ConfigProvider, resolveAliasTarget } from "@aio-proxy/types";
import { RouterModelCollisionError, RouterModelNotFoundError } from "./error";
import type { AiSdkProviderInstance } from "./provider/ai-sdk";
import type { ApiProviderInstance } from "./provider/api";

export type ProviderInstance = (ConfigProvider & { readonly id: string }) | ApiProviderInstance | AiSdkProviderInstance;

export type RouterResolution<TProvider extends ProviderInstance = ProviderInstance> = {
  readonly provider: TProvider;
  readonly modelId: string;
};

export type RouterCandidate<TProvider extends ProviderInstance = ProviderInstance> = RouterResolution<TProvider>;

export type ModelRoute = {
  readonly alias: string;
  readonly modelId: string;
};

type ConfiguredRouterRoute<TProvider extends ProviderInstance> = {
  readonly provider: TProvider;
  readonly config: AliasConfig;
};

export class Router<TProvider extends ProviderInstance = ProviderInstance> {
  private readonly aliases = new Map<string, ConfiguredRouterRoute<TProvider>[]>();
  private readonly providerAliases = new Map<string, ConfiguredRouterRoute<TProvider>>();

  constructor(providers: readonly TProvider[]) {
    for (const provider of providers) {
      if (provider.enabled === false) {
        continue;
      }

      for (const [alias, config] of Object.entries(provider.alias ?? {})) {
        this.addRoute(provider, alias, config);
      }
      for (const modelId of directModelIds(provider)) {
        this.addRoute(provider, modelId, { model: modelId, preserve: false });
      }
    }
  }

  resolve(model: string, variantKey?: string): RouterCandidate<TProvider>[] {
    const route = model.indexOf("/") > 0 ? this.providerAliases.get(model) : this.aliases.get(model);

    if (route === undefined) {
      throw new RouterModelNotFoundError(model);
    }

    const routes = Array.isArray(route) ? route : [route];
    return routes.map(({ config, provider }) => ({
      provider,
      modelId: resolveAliasTarget(config, variantKey).model,
    }));
  }

  private addRoute(provider: TProvider, alias: string, config: AliasConfig): void {
    const route = { provider, config };
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
}

export function modelRoutes(provider: ProviderInstance): ModelRoute[] {
  const routes = Object.entries(provider.alias ?? {}).map(([alias, config]) => ({ alias, modelId: config.model }));
  for (const modelId of directModelIds(provider)) {
    if (!routes.some((route) => route.alias === modelId && route.modelId === modelId)) {
      routes.push({ alias: modelId, modelId });
    }
  }
  return routes;
}

function directModelIds(provider: ProviderInstance): string[] {
  const modelIds = new Set<string>("models" in provider ? (provider.models ?? []) : []);
  for (const config of Object.values(provider.alias ?? {})) {
    modelIds.delete(config.model);
    for (const target of Object.values(config.variants ?? {})) {
      modelIds.delete(target.model);
    }
  }
  for (const modelId of preservedModelIds(provider)) {
    modelIds.add(modelId);
  }
  return [...modelIds];
}

function preservedModelIds(provider: ProviderInstance): string[] {
  const modelIds = new Set<string>();
  for (const config of Object.values(provider.alias ?? {})) {
    if (config.preserve) {
      modelIds.add(config.model);
    }
  }

  for (const config of Object.values(provider.alias ?? {})) {
    for (const target of Object.values(config.variants ?? {})) {
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
  return new Set([config.model, ...Object.values(config.variants ?? {}).map((target) => target.model)]);
}
