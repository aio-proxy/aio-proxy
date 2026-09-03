import {
  digestProviderEntry,
  type PluginRepository,
  modelRoutes,
  type RoutableProvider,
  validateModelCatalog,
} from '@aio-proxy/core';
import {
  type Config,
  type DashboardProviderSummary,
  type DashboardRoutingModel,
  type DashboardRoutingModelsResponse,
  type DashboardRoutingNumber,
  type DashboardRoutingProvider,
  type ModelCostInput,
  ModelCostSchema,
  type ModelLimitInput,
  ModelLimitSchema,
  type ModelMetadataInput,
  ModelMetadataSchema,
  oauthExposedModels,
  type Provider,
  type ProviderAlias,
  ProviderKind,
  resolveOAuthAlias,
  RoutingPrioritySchema,
  RoutingWeightSchema,
} from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { rawModelPolicySlugs, readRawModelPolicy, rawPolicyProviders } from './mutation';
import { authoredNumber, routingNumberView } from './number-view';

export type RoutingInventoryInput = {
  readonly rawRecord: Readonly<Record<string, unknown>>;
  readonly config: Config;
  readonly summaries: readonly DashboardProviderSummary[];
  readonly repository: Pick<PluginRepository, 'readCatalog' | 'readAccount'>;
  readonly writable: boolean;
  readonly pluginDefaults?: (
    provider: Extract<Provider, { kind: typeof ProviderKind.OAuth }>,
  ) => ProviderAlias | undefined;
};

export async function assembleRoutingInventory(input: RoutingInventoryInput): Promise<DashboardRoutingModelsResponse> {
  const providers = orderedProviders(input.rawRecord, input.config);
  const summaries = new Map(input.summaries.map((summary) => [summary.id, summary]));
  const rawProviders = objectRecord(input.rawRecord['providers']);
  const models = new Map<string, WritableModel>();

  for (const provider of providers) {
    const source = await syntheticSource(provider, input.repository, input.pluginDefaults);
    const name = routingProviderName(provider, summaries.get(provider.id), input.repository);
    for (const route of modelRoutes(source)) {
      let model = models.get(route.alias);
      if (model === undefined) {
        model = emptyModel(route.alias, input.rawRecord);
        models.set(route.alias, model);
      }
      model.providers.push(
        providerRow(
          provider,
          summaries.get(provider.id),
          rawProviders[provider.id],
          rawPolicyProviders(readRawModelPolicy(input.rawRecord, route.alias))[provider.id],
          input.writable,
          name,
        ),
      );
    }
  }
  for (const slug of rawModelPolicySlugs(input.rawRecord)) {
    if (!models.has(slug)) models.set(slug, emptyModel(slug, input.rawRecord));
  }

  return {
    writable: input.writable,
    models: [...models.values()].map(finalizeModel),
  };
}

function emptyModel(modelId: string, rawRecord: Readonly<Record<string, unknown>>): WritableModel {
  const rawPolicy = readRawModelPolicy(rawRecord, modelId);
  return {
    modelId,
    revision: digestProviderEntry(rawPolicy ?? null),
    rawMetadata: isPlainObject(rawPolicy) ? rawPolicy['metadata'] : undefined,
    providers: [],
  };
}

function finalizeModel(model: WritableModel): DashboardRoutingModel {
  const totals = new Map<number, number>();
  for (const provider of model.providers) {
    if (!provider.effective.eligible) continue;
    totals.set(provider.effective.priority, (totals.get(provider.effective.priority) ?? 0) + provider.effective.weight);
  }
  const providers = model.providers.map((provider) => {
    if (!provider.effective.eligible) return provider;
    const total = totals.get(provider.effective.priority) ?? 0;
    return {
      ...provider,
      effective: { ...provider.effective, share: total === 0 ? 0 : provider.effective.weight / total },
    };
  });
  const priorities = [...totals.keys()].sort((left, right) => right - left);
  const parsedMetadata = ModelMetadataSchema.safeParse(model.rawMetadata);
  const metadata = parsedMetadata.success ? (model.rawMetadata as ModelMetadataInput) : undefined;
  return {
    modelId: model.modelId,
    ...(metadata === undefined ? {} : { metadata }),
    revision: model.revision,
    baselineProviderIds: providers.map((provider) => provider.id),
    providerCount: providers.length,
    eligibleProviderCount: providers.filter((provider) => provider.effective.eligible).length,
    hasOverrides: providers.some((provider) => provider.override !== undefined) || metadata !== undefined,
    tiers: priorities.map((priority) => ({
      priority,
      providers: providers
        .filter((provider) => provider.effective.eligible && provider.effective.priority === priority)
        .map((provider) => ({
          providerId: provider.id,
          weight: provider.effective.weight,
          share: provider.effective.share ?? 0,
        })),
    })),
    providers,
  };
}

function routingProviderName(
  provider: Provider,
  summary: DashboardProviderSummary | undefined,
  repository: Pick<PluginRepository, 'readAccount'>,
): string | undefined {
  if (provider.kind !== ProviderKind.OAuth) return provider.name ?? summary?.name;
  try {
    const account = repository.readAccount(provider.id);
    return account?.label ?? account?.fingerprint ?? summary?.accountLabel ?? provider.name ?? summary?.name;
  } catch {
    return summary?.accountLabel ?? provider.name ?? summary?.name;
  }
}

function providerRow(
  provider: Provider,
  summary: DashboardProviderSummary | undefined,
  rawProvider: unknown,
  rawOverride: unknown,
  discloseAuthored: boolean,
  name: string | undefined,
): DashboardRoutingProvider {
  const raw = isPlainObject(rawProvider) ? rawProvider : {};
  const defaults = {
    priority: routingNumberView(discloseAuthored ? authoredNumber(raw['priority']) : undefined, provider.priority),
    weight: routingNumberView(discloseAuthored ? authoredNumber(raw['weight']) : undefined, provider.weight),
  };
  const override = overrideView(rawOverride, discloseAuthored);
  const priority = override?.priority?.effective ?? defaults.priority.effective;
  const weight = override?.weight?.effective ?? defaults.weight.effective;
  const state = summary?.state ?? { status: 'ready' };
  return {
    id: provider.id,
    ...(name === undefined ? {} : { name }),
    kind: provider.kind,
    enabled: provider.enabled,
    state,
    defaults,
    ...(override === undefined ? {} : { override }),
    effective: {
      priority,
      weight,
      prioritySource: override?.priority === undefined ? 'provider' : 'model',
      weightSource: override?.weight === undefined ? 'provider' : 'model',
      eligible: provider.enabled && state.status === 'ready' && weight > 0,
      share: null,
    },
  };
}

function overrideView(rawOverride: unknown, discloseAuthored: boolean): DashboardRoutingProvider['override'] {
  if (!isPlainObject(rawOverride)) return undefined;
  const priority = parsedNumberView(rawOverride['priority'], RoutingPrioritySchema, discloseAuthored);
  const weight = parsedNumberView(rawOverride['weight'], RoutingWeightSchema, discloseAuthored);
  const parsedCost = ModelCostSchema.safeParse(rawOverride['cost']);
  const cost = parsedCost.success ? (rawOverride['cost'] as ModelCostInput) : undefined;
  const parsedLimit = ModelLimitSchema.safeParse(rawOverride['limit']);
  const limit = parsedLimit.success ? (rawOverride['limit'] as ModelLimitInput) : undefined;
  if (priority === undefined && weight === undefined && cost === undefined && limit === undefined) return undefined;
  return {
    ...(priority === undefined ? {} : { priority }),
    ...(weight === undefined ? {} : { weight }),
    ...(cost === undefined ? {} : { cost }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function parsedNumberView(
  raw: unknown,
  schema: typeof RoutingPrioritySchema | typeof RoutingWeightSchema,
  discloseAuthored: boolean,
): DashboardRoutingNumber | undefined {
  if (raw === undefined) return undefined;
  const authored = authoredNumber(raw);
  if (authored === undefined) return undefined;
  const parsed = schema.safeParse(authored);
  if (!parsed.success) return undefined;
  return routingNumberView(discloseAuthored ? authored : undefined, parsed.data);
}

async function syntheticSource(
  provider: Provider,
  repository: Pick<PluginRepository, 'readCatalog'>,
  pluginDefaults?: RoutingInventoryInput['pluginDefaults'],
): Promise<RoutableProvider> {
  if (provider.kind === ProviderKind.OAuth) {
    const models = await oauthCatalogModels(provider, repository);
    const alias = resolveOAuthAlias(
      provider.alias,
      pluginDefaults?.(provider),
      models === undefined ? undefined : models,
    );
    return {
      id: provider.id,
      enabled: provider.enabled,
      ...(models === undefined || models.length === 0 ? {} : { models }),
      ...(Object.keys(alias).length === 0 ? {} : { alias }),
    };
  }
  const models = provider.models ?? [];
  return {
    id: provider.id,
    enabled: provider.enabled,
    ...(models.length === 0 ? {} : { models }),
    ...(provider.alias === undefined ? {} : { alias: provider.alias }),
  };
}

async function oauthCatalogModels(
  provider: Extract<Provider, { kind: typeof ProviderKind.OAuth }>,
  repository: Pick<PluginRepository, 'readCatalog'>,
): Promise<readonly string[] | undefined> {
  try {
    const stored = repository.readCatalog(provider.id);
    if (stored === null) return undefined;
    return oauthExposedModels(
      validateModelCatalog(stored.catalog).language.map((entry) => entry.id),
      provider.excludedModels,
    );
  } catch {
    return undefined;
  }
}

function orderedProviders(rawRecord: Readonly<Record<string, unknown>>, config: Config): readonly Provider[] {
  const byId = new Map(config.providers.map((provider) => [provider.id, provider]));
  const ordered: Provider[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys(objectRecord(rawRecord['providers']))) {
    const provider = byId.get(id);
    if (provider === undefined) continue;
    ordered.push(provider);
    seen.add(id);
  }
  for (const provider of config.providers) {
    if (!seen.has(provider.id)) ordered.push(provider);
  }
  return ordered;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

type WritableModel = {
  modelId: string;
  revision: string;
  rawMetadata: unknown;
  providers: DashboardRoutingProvider[];
};
