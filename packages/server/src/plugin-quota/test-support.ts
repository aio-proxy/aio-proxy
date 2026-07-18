import { createPluginRegistryHost, type PluginLogSink, Router } from "@aio-proxy/core";
import { type AccountContext, type OAuthAdapter, type OAuthQuotaSnapshot, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema, ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { createSnapshotManager } from "../plugin-snapshot";
import type { ProviderRouteSnapshot, RuntimeProviderInstance } from "../runtime";
import type { OAuthQuotaServiceDependencies } from "./context";
import {
  CAPABILITY,
  cleanupQuotaRepositories,
  createQuotaRepository,
  diagnostics,
  PLUGIN,
  PROVIDER_ID,
  type QuotaAccountFixtureState,
} from "./quota-repository.test-support";

export type QuotaFixtureOptions = {
  readonly provider?: "oauth" | "api" | "missing";
  readonly pluginState?: "ready" | "failed" | "missing";
  readonly capability?: "ready" | "missing" | "throw";
  readonly account?: QuotaAccountFixtureState;
  readonly quota?: boolean;
  readonly pluginSecretFailure?: boolean;
  readonly loggerFailure?: boolean;
  readonly read?: (context: AccountContext<unknown, unknown>) => Promise<OAuthQuotaSnapshot>;
  readonly itemId?: string;
  readonly region?: string;
};

export function cleanupQuotaFixtures(): void {
  cleanupQuotaRepositories();
}

function providerConfig(
  kind: QuotaFixtureOptions["provider"],
  optionsRegion: string,
): ReturnType<typeof ConfigSchema.parse> {
  const provider =
    kind === "api"
      ? {
          kind: ProviderKind.Api,
          protocol: ProviderProtocol.OpenAICompatible,
          baseURL: "https://example.com",
        }
      : {
          kind: ProviderKind.OAuth,
          plugin: PLUGIN,
          capability: CAPABILITY,
          options: { region: "us-east" },
        };
  if (kind === "missing") return ConfigSchema.parse({ providers: {} });
  return ConfigSchema.parse({
    providers: {
      decoy: {
        kind: ProviderKind.OAuth,
        plugin: PLUGIN,
        capability: CAPABILITY,
        weight: 100,
        options: { region: "decoy" },
      },
      [PROVIDER_ID]: kind === "oauth" ? { ...provider, options: { region: optionsRegion } } : provider,
    },
  });
}

function runtimeProvider(): RuntimeProviderInstance {
  const provider = {
    id: PROVIDER_ID,
    kind: ProviderKind.OAuth,
    enabled: true,
    models: ["model"],
    plugin: PLUGIN,
    capability: CAPABILITY,
  } as Record<string, unknown>;
  Object.defineProperties(provider, {
    raw: {
      get: () => {
        throw new Error("raw capability inspected");
      },
    },
    model: {
      get: () => {
        throw new Error("model capability inspected");
      },
    },
  });
  return provider as RuntimeProviderInstance;
}

export function createQuotaFixture(options: QuotaFixtureOptions = {}) {
  const logs: Parameters<PluginLogSink>[0][] = [];
  const contexts: AccountContext<unknown, unknown>[] = [];
  let changed = 0;
  let readCalls = 0;
  const host = createPluginRegistryHost();
  const staging = host.stage(PLUGIN);
  const adapter: OAuthAdapter = {
    id: CAPABILITY,
    label: "Example",
    account: {
      options: {
        schema: zod.object({ region: zod.string(), clientSecret: zod.string() }),
        form: [{ type: "secret", key: "clientSecret", label: "Client secret" }],
      },
    },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error("not called");
    },
    catalog: {
      policy: { kind: "static" },
      async discover() {
        throw new Error("not called");
      },
    },
    async createRuntime() {
      throw new Error("not called");
    },
    ...(options.quota === false
      ? {}
      : {
          quota: {
            async read(context) {
              readCalls++;
              contexts.push(context);
              return (
                options.read?.(context) ?? {
                  items: [{ id: options.itemId ?? "default", label: "Default" }],
                }
              );
            },
          },
        }),
  };
  staging.api.oauth.register(adapter);
  staging.seal();
  staging.commit();
  const registry =
    options.capability === "missing"
      ? { ...host.registry, resolveOAuth: () => undefined }
      : options.capability === "throw"
        ? {
            ...host.registry,
            resolveOAuth: () => {
              throw new Error("registry failed");
            },
          }
        : host.registry;
  const plugins = {
    registry,
    plugins: new Map(
      options.pluginState === "missing"
        ? []
        : [
            [
              PLUGIN,
              {
                packageName: PLUGIN,
                version: "1.0.0",
                builtIn: false,
                state:
                  options.pluginState === "failed"
                    ? { status: "failed", diagnostic: diagnostics("PLUGIN_LOAD_FAILED", { retryable: false }) }
                    : { status: "ready" },
              },
            ] as const,
          ],
    ),
  };
  const repository = createQuotaRepository(options.account);
  const dependencyRepository = options.pluginSecretFailure
    ? {
        ...repository,
        readPluginSecret: () => {
          throw new Error("plugin secret failed");
        },
      }
    : repository;
  const providers = [runtimeProvider()];
  const snapshot: ProviderRouteSnapshot = {
    config: providerConfig(options.provider ?? "oauth", options.region ?? "us-east"),
    plugins: plugins as never,
    providers,
    router: new Router(providers),
    providerStates: new Map([[PROVIDER_ID, { status: "ready" }]]),
  };
  const manager = createSnapshotManager(snapshot);
  const dependencies: OAuthQuotaServiceDependencies = {
    acquireSnapshot: manager.acquire,
    repository: dependencyRepository,
    diagnostics,
    logger: (entry) => {
      if (options.loggerFailure) throw new Error("quota logger failed");
      logs.push(entry);
    },
    onDiagnosticChanged: () => {
      changed++;
    },
  };
  return {
    contexts,
    dependencies,
    logs,
    manager,
    repository,
    snapshot,
    changed: () => changed,
    readCalls: () => readCalls,
  };
}

export { CAPABILITY, diagnostics, PLUGIN, PROVIDER_ID };
