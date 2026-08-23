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
  type Provider,
  ProviderKind,
  RoutingPrioritySchema,
  RoutingWeightSchema,
} from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { readRawModelPolicy, rawPolicyProviders } from './mutation';
import { authoredNumber, routingNumberView } from './number-view';

export type RoutingInventoryInput = {
  readonly rawRecord: Readonly<Record<string, unknown>>;
  readonly config: Config;
  readonly summaries: readonly DashboardProviderSummary[];
  readonly repository: Pick<PluginRepository, 'readCatalog'>;
  readonly writable: boolean;
};

export async function assembleRoutingInventory(input: RoutingInventoryInput): Promise<DashboardRoutingModelsResponse> {
  const providers = orderedProviders(input.rawRecord, input.config);
  const summaries = new Map(input.summaries.map((summary) => [summary.id, summary]));
  const rawProviders = objectRecord(input.rawRecord['providers']);
  const models = new Map<string, WritableModel>();

  for (const provider of providers) {
    const source = await syntheticSource(provider, input.repository);
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
        ),
      );
    }
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
  return {
    modelId: model.modelId,
    revision: model.revision,
    baselineProviderIds: providers.map((provider) => provider.id),
    providerCount: providers.length,
    eligibleProviderCount: providers.filter((provider) => provider.effective.eligible).length,
    hasOverrides: providers.some((provider) => provider.override !== undefined),
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

function providerRow(
  provider: Provider,
  summary: DashboardProviderSummary | undefined,
  rawProvider: unknown,
  rawOverride: unknown,
  discloseAuthored: boolean,
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
    ...(provider.name === undefined ? {} : { name: provider.name }),
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
  if (priority === undefined && weight === undefined) return undefined;
  return {
    ...(priority === undefined ? {} : { priority }),
    ...(weight === undefined ? {} : { weight }),
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
): Promise<RoutableProvider> {
  const models =
    provider.kind === ProviderKind.OAuth
      ? await oauthCatalogModels(provider.id, repository)
      : 'models' in provider
        ? (provider.models ?? [])
        : [];
  return {
    id: provider.id,
    enabled: provider.enabled,
    ...(models.length === 0 ? {} : { models }),
    ...(provider.alias === undefined ? {} : { alias: provider.alias }),
  };
}

async function oauthCatalogModels(
  providerId: string,
  repository: Pick<PluginRepository, 'readCatalog'>,
): Promise<readonly string[]> {
  try {
    const stored = repository.readCatalog(providerId);
    if (stored === null) return [];
    return validateModelCatalog(stored.catalog).language.map((entry) => entry.id);
  } catch {
    return [];
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
  providers: DashboardRoutingProvider[];
};
