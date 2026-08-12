import { type AliasConfig, directModelIds, type ModelId, resolveAliasTarget, sameRouteTargets } from '@aio-proxy/types';

import { RouterModelCollisionError, RouterModelNotFoundError } from './error';
import type { AiSdkProviderInstance } from './provider/ai-sdk/index';
import type { ApiProviderInstance } from './provider/api/index';

export { modelRoutes } from '@aio-proxy/types';
export type { ModelRoute } from '@aio-proxy/types';

export type RoutableProvider = {
  readonly id: string;
  readonly enabled: boolean;
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

export type RouterCandidate<TProvider extends RoutableProvider = ProviderInstance> = RouterResolution<TProvider>;

type ConfiguredRouterRoute<TProvider extends RoutableProvider> = {
  readonly provider: TProvider;
  readonly config: AliasConfig;
};

export class Router<TProvider extends RoutableProvider = ProviderInstance> {
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
    const route = model.indexOf('/') > 0 ? this.providerAliases.get(model) : this.aliases.get(model);

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
