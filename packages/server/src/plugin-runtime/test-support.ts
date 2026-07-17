import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginRegistryHost,
  createPluginRepository,
  type DiagnosticFactory,
  type PluginRepository,
} from "@aio-proxy/core";
import { type OpenDbHandle, openDb } from "@aio-proxy/core/db";
import { type ModelCatalog, type OAuthAdapter, zod } from "@aio-proxy/plugin-sdk";
import {
  type MaterializePluginProviderOptions,
  materializePluginProvider as materializePluginProviderWithDigest,
  pluginOptionsIdentityDigest,
} from "./index";

export const homes: string[] = [];
const handles: OpenDbHandle[] = [];

export function cleanup(): void {
  for (const handle of handles.splice(0)) handle.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

export const catalog: ModelCatalog = {
  language: [{ id: "model" }],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
};

export const diagnostics: DiagnosticFactory = (code, options) => ({
  code,
  summary: code,
  retryable: options.retryable,
  occurredAt: new Date(0).toISOString(),
  ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
});

export const emptyPluginOptionsDigest = pluginOptionsIdentityDigest({ public: undefined, secret: undefined });

export function refreshCredential(repository: PluginRepository, expectedRevision: number, credential: unknown): void {
  const owner = crypto.randomUUID();
  const now = Date.now();
  if (!repository.tryAcquireRefreshLease("person", owner, now, now + 60_000)) throw new Error("lease unavailable");
  try {
    repository.compareAndSwapCredential("person", expectedRevision, owner, credential);
  } finally {
    repository.releaseRefreshLease("person", owner);
  }
}

export function materializePluginProvider(
  options: Omit<MaterializePluginProviderOptions, "pluginOptionsDigest"> & {
    readonly pluginOptionsDigest?: MaterializePluginProviderOptions["pluginOptionsDigest"];
  },
) {
  return materializePluginProviderWithDigest({ pluginOptionsDigest: emptyPluginOptionsDigest, ...options });
}

export function runtimeFixture(
  policy: OAuthAdapter["catalog"]["policy"],
  overrides: {
    readonly accountOptionsSchema?: OAuthAdapter["account"]["options"]["schema"];
    readonly catalog?: ModelCatalog | null;
    readonly createRuntime?: OAuthAdapter["createRuntime"];
    readonly providerId?: string;
  } = {},
): {
  readonly repository: PluginRepository;
  readonly plugins: Parameters<typeof materializePluginProvider>[0]["plugins"];
  readonly createCalls: () => number;
} {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-runtime-"));
  homes.push(home);
  const handle = openDb({ home });
  handles.push(handle);
  const repository = createPluginRepository(handle.sqlite);
  const fixtureCatalog = overrides.catalog === undefined ? catalog : overrides.catalog;
  const providerId = overrides.providerId ?? "person";
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId,
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: `${providerId}@example.com`,
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog:
        fixtureCatalog === null
          ? {
              kind: "missing",
              diagnostic: diagnostics("CATALOG_UNAVAILABLE", { providerId, retryable: true }),
            }
          : { kind: "replace", value: { catalog: fixtureCatalog, refreshedAt: 1_000 } },
    },
  });
  repository.completeAccountOperation(operation.operationId);

  const host = createPluginRegistryHost();
  let calls = 0;
  const staging = host.stage("@example/oauth");
  staging.api.oauth.register({
    id: "default",
    label: "Example",
    account: { options: { schema: overrides.accountOptionsSchema ?? zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error("not called");
    },
    catalog: {
      policy,
      async discover() {
        return fixtureCatalog ?? catalog;
      },
    },
    async createRuntime(context) {
      calls++;
      if (overrides.createRuntime !== undefined) return overrides.createRuntime(context as never);
      return {
        provider: {
          specificationVersion: "v4",
          languageModel() {
            throw new Error("not called");
          },
          imageModel() {
            throw new Error("not called");
          },
          embeddingModel() {
            throw new Error("not called");
          },
        },
      } as never;
    },
  });
  staging.seal();
  staging.commit();
  return {
    repository,
    createCalls: () => calls,
    plugins: {
      registry: host.registry,
      plugins: new Map([
        [
          "@example/oauth",
          { packageName: "@example/oauth", version: "1.0.0", builtIn: false, state: { status: "ready" } },
        ],
      ]),
    },
  };
}
