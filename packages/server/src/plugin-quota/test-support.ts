import { expect } from 'bun:test';

import { createPluginRegistryHost, type PluginLogSink, Router } from '@aio-proxy/core';
import { type AccountContext, type OAuthAdapter, type OAuthQuotaSnapshot, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createSnapshotManager } from '../plugin-snapshot';
import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../runtime';
import type { OAuthQuotaServiceDependencies } from './context';
import {
  CAPABILITY,
  cleanupQuotaRepositories,
  createQuotaRepository,
  diagnostics,
  PLUGIN,
  PROVIDER_ID,
  type QuotaAccountFixtureState,
} from './quota-repository.test-support';

export type QuotaFixtureOptions = {
  readonly provider?: 'oauth' | 'api' | 'missing';
  readonly pluginState?: 'ready' | 'failed' | 'missing';
  readonly capability?: 'ready' | 'missing' | 'throw';
  readonly account?: QuotaAccountFixtureState;
  readonly quota?: boolean;
  readonly accountOptions?: OAuthAdapter['account']['options'];
  readonly credentials?: OAuthAdapter['credentials'];
  readonly pluginSecretFailure?: boolean;
  readonly loggerFailure?: boolean;
  readonly read?: (context: AccountContext<unknown, unknown>) => Promise<OAuthQuotaSnapshot>;
  readonly reset?: (context: AccountContext<unknown, unknown>) => Promise<void>;
  readonly additionalProviderIds?: readonly string[];
  readonly itemId?: string;
  readonly region?: string;
  readonly proxy?: string;
};

type QuotaAdapterTracker = {
  readonly contexts: AccountContext<unknown, unknown>[];
  readonly resetContexts: AccountContext<unknown, unknown>[];
  readCalls: number;
  resetCalls: number;
};

export function cleanupQuotaFixtures(): void {
  cleanupQuotaRepositories();
}

export const availableQuotaSnapshot: OAuthQuotaSnapshot = {
  items: [],
  resetCredits: { availableCount: 1 },
};

export function quotaSignal(): AbortSignal {
  return new AbortController().signal;
}

export async function capturedQuotaError(promise: Promise<unknown>): Promise<Error & { readonly code?: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & { readonly code?: string };
  }
  throw new Error('expected operation to reject');
}

function providerConfig(
  kind: QuotaFixtureOptions['provider'],
  optionsRegion: string,
  providerIds: readonly string[],
  proxy: string | undefined,
): ReturnType<typeof ConfigSchema.parse> {
  const provider =
    kind === 'api'
      ? {
          kind: ProviderKind.Api,
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: 'https://example.com',
        }
      : {
          kind: ProviderKind.OAuth,
          plugin: PLUGIN,
          capability: CAPABILITY,
          options: { region: 'us-east' },
        };
  if (kind === 'missing') return ConfigSchema.parse({ providers: {} });
  const providers = {
    decoy: {
      kind: ProviderKind.OAuth,
      plugin: PLUGIN,
      capability: CAPABILITY,
      weight: 100,
      options: { region: 'decoy' },
    },
    ...Object.fromEntries(
      providerIds.map((providerId) => [
        providerId,
        kind === 'oauth'
          ? { ...provider, options: { region: providerId === PROVIDER_ID ? optionsRegion : `${providerId}-region` } }
          : provider,
      ]),
    ),
  };
  return ConfigSchema.parse({ providers, ...(proxy === undefined ? {} : { proxy }) });
}

function runtimeProvider(id: string): RuntimeProviderInstance {
  const provider = {
    id,
    kind: ProviderKind.OAuth,
    enabled: true,
    models: ['model'],
    plugin: PLUGIN,
    capability: CAPABILITY,
  } as Record<string, unknown>;
  Object.defineProperties(provider, {
    raw: {
      get: () => {
        throw new Error('raw capability inspected');
      },
    },
    model: {
      get: () => {
        throw new Error('model capability inspected');
      },
    },
  });
  return provider as RuntimeProviderInstance;
}

function buildQuotaAdapter(options: QuotaFixtureOptions, tracker: QuotaAdapterTracker): OAuthAdapter {
  return {
    id: CAPABILITY,
    displayName: 'Example',
    account: {
      options: options.accountOptions ?? {
        schema: zod.object({ region: zod.string(), clientSecret: zod.string() }),
        form: [{ type: 'secret', key: 'clientSecret', label: 'Client secret' }],
      },
    },
    credentials: options.credentials ?? zod.object({ token: zod.string() }),
    async login() {
      throw new Error('not called');
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        throw new Error('not called');
      },
    },
    async createRuntime() {
      throw new Error('not called');
    },
    ...(options.quota === false
      ? {}
      : {
          quota: {
            async read(context) {
              tracker.readCalls++;
              tracker.contexts.push(context);
              return (
                options.read?.(context) ?? {
                  items: [{ id: options.itemId ?? 'default', displayName: 'Default' }],
                }
              );
            },
            ...(options.reset === undefined
              ? {}
              : {
                  async reset(context: AccountContext<unknown, unknown>) {
                    tracker.resetCalls++;
                    tracker.resetContexts.push(context);
                    await options.reset?.(context);
                  },
                }),
          },
        }),
  };
}

export function createQuotaFixture(options: QuotaFixtureOptions = {}) {
  const logs: Parameters<PluginLogSink>[0][] = [];
  const tracker: QuotaAdapterTracker = { contexts: [], resetContexts: [], readCalls: 0, resetCalls: 0 };
  let changed = 0;
  const providerIds = [PROVIDER_ID, ...(options.additionalProviderIds ?? [])];
  const host = createPluginRegistryHost();
  const staging = host.stage(PLUGIN);
  staging.api.oauth.register(buildQuotaAdapter(options, tracker));
  staging.seal();
  staging.commit();
  let registry = host.registry;
  if (options.capability === 'missing') registry = { ...host.registry, resolveOAuth: () => undefined };
  else if (options.capability === 'throw') {
    registry = {
      ...host.registry,
      resolveOAuth: () => {
        throw new Error('registry failed');
      },
    };
  }
  const plugins = {
    registry,
    plugins: new Map(
      options.pluginState === 'missing'
        ? []
        : [
            [
              PLUGIN,
              {
                packageName: PLUGIN,
                version: '1.0.0',
                builtIn: false,
                state:
                  options.pluginState === 'failed'
                    ? { status: 'failed', diagnostic: diagnostics('PLUGIN_LOAD_FAILED', { retryable: false }) }
                    : { status: 'ready' },
              },
            ] as const,
          ],
    ),
  };
  const repository = createQuotaRepository(options.account, providerIds);
  const dependencyRepository = options.pluginSecretFailure
    ? {
        ...repository,
        readPluginSecret: () => {
          throw new Error('plugin secret failed');
        },
      }
    : repository;
  const providers = providerIds.map(runtimeProvider);
  const snapshot: ProviderRouteSnapshot = {
    config: providerConfig(options.provider ?? 'oauth', options.region ?? 'us-east', providerIds, options.proxy),
    plugins: plugins as never,
    providers,
    router: new Router(providers),
    providerStates: new Map(providerIds.map((providerId) => [providerId, { status: 'ready' }] as const)),
  };
  const manager = createSnapshotManager(snapshot);
  const dependencies: OAuthQuotaServiceDependencies = {
    acquireSnapshot: manager.acquire,
    repository: dependencyRepository,
    diagnostics,
    logger: (entry) => {
      if (options.loggerFailure) throw new Error('quota logger failed');
      logs.push(entry);
    },
    onDiagnosticChanged: () => {
      changed++;
    },
  };
  return {
    contexts: tracker.contexts,
    resetContexts: tracker.resetContexts,
    dependencies,
    logs,
    manager,
    repository,
    snapshot,
    changed: () => changed,
    readCalls: () => tracker.readCalls,
    resetCalls: () => tracker.resetCalls,
  };
}

export { CAPABILITY, diagnostics, PLUGIN, PROVIDER_ID };
