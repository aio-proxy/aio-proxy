import type { PluginRepository } from '@aio-proxy/core';
import type {
  Config,
  DashboardProviderSummary,
  DashboardRoutingModelMutation,
  DashboardRoutingModelsResponse,
  DashboardRoutingNumber,
} from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import type { ConfigStore } from '../config-store';
import { assembleRoutingInventory } from './inventory';
import { applyRoutingMutation } from './mutation';
import { authoredNumber, routingNumberView } from './number-view';

export type ProviderRoutingNumberViews = {
  readonly priority: DashboardRoutingNumber;
  readonly weight: DashboardRoutingNumber;
};

export type ModelRoutingControlPlane = {
  readonly list: () => Promise<DashboardRoutingModelsResponse>;
  readonly update: (input: DashboardRoutingModelMutation) => Promise<DashboardRoutingModelsResponse>;
  readonly providerNumberViews: (providerId: string) => Promise<ProviderRoutingNumberViews | undefined>;
};

export type ModelRoutingControlPlaneOptions = {
  readonly currentConfig: () => Config;
  readonly currentSummaries: () => readonly DashboardProviderSummary[];
  readonly repository: PluginRepository;
  readonly configStore: ConfigStore;
};

export function createModelRoutingControlPlane(options: ModelRoutingControlPlaneOptions): ModelRoutingControlPlane {
  async function rawRecord(): Promise<{ readonly record: Record<string, unknown>; readonly writable: boolean }> {
    if (options.configStore.file !== undefined) {
      return { record: await options.configStore.file.read(), writable: true };
    }
    return { record: recordFromConfig(options.currentConfig()), writable: false };
  }

  async function list(): Promise<DashboardRoutingModelsResponse> {
    const { record, writable } = await rawRecord();
    return assembleRoutingInventory({
      rawRecord: record,
      config: options.currentConfig(),
      summaries: options.currentSummaries(),
      repository: options.repository,
      writable,
    });
  }

  return {
    list,
    async update(input) {
      await options.configStore.mutateConfig((current) => applyRoutingMutation(current, input));
      return list();
    },
    async providerNumberViews(providerId) {
      const provider = options.currentConfig().providers.find((entry) => entry.id === providerId);
      if (provider === undefined) return undefined;
      const { record, writable } = await rawRecord();
      const raw = objectRecord(record['providers'])[providerId];
      const authored = isPlainObject(raw) ? raw : {};
      return {
        priority: routingNumberView(writable ? authoredNumber(authored['priority']) : undefined, provider.priority),
        weight: routingNumberView(writable ? authoredNumber(authored['weight']) : undefined, provider.weight),
      };
    },
  };
}

function recordFromConfig(config: Config): Record<string, unknown> {
  return {
    providers: Object.fromEntries(config.providers.map(({ id, ...rest }) => [id, rest])),
    router: config.router,
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}
