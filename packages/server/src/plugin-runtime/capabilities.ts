import type {
  LogicalRequestContext,
  ModelCatalog,
  ProtocolId,
  ProviderExecutedTool,
  ProviderToolCapability,
  RawResolver,
  TokenCountCapability,
} from "@aio-proxy/plugin-sdk";

import { createProviderV4Invoke, validateProviderV4 } from "@aio-proxy/core";
import { type OAuthProvider, ProviderKind, type ProviderProtocol } from "@aio-proxy/types";

import type { RuntimeProviderInstance } from "../runtime";

import { modelMetadata } from "./catalog";
import { PluginRawResolverError, PluginRawTransportError } from "./types";

export const pluginProtocol = {
  "openai-compatible": "openai-compatible",
  "openai-response": "openai-response",
  anthropic: "anthropic",
  gemini: "gemini",
} as const satisfies Record<ProviderProtocol, ProtocolId>;

function rawCapability(rawResolver: RawResolver | undefined, catalog: ModelCatalog) {
  if (rawResolver === undefined) return undefined;
  const languageCatalogById = new Map(catalog.language.map((descriptor) => [descriptor.id, descriptor]));
  return {
    resolve({ protocol, modelId }: { readonly protocol: ProviderProtocol; readonly modelId: string }) {
      const descriptor = languageCatalogById.get(modelId);
      const transport = rawResolver({
        protocol: pluginProtocol[protocol],
        modelId,
        ...(descriptor?.metadata === undefined ? {} : { metadata: descriptor.metadata }),
      });
      if (transport === undefined) return undefined;
      if (
        typeof transport !== "object" ||
        transport === null ||
        Array.isArray(transport) ||
        typeof transport.invoke !== "function"
      ) {
        throw new PluginRawResolverError();
      }
      return {
        async invoke(request: Request, context?: LogicalRequestContext): Promise<Response> {
          const response = await transport.invoke(request, context);
          if (!(response instanceof Response)) throw new PluginRawTransportError();
          return response;
        },
      };
    },
  };
}

export function withRoutingConfig(provider: RuntimeProviderInstance, config: OAuthProvider): RuntimeProviderInstance {
  const { alias: _previousAlias, ...previousProvider } = provider;
  return {
    ...previousProvider,
    enabled: config.enabled,
    ...(config.alias === undefined ? {} : { alias: config.alias }),
  };
}

export function createRuntimeProvider(
  config: OAuthProvider,
  result: unknown,
  catalog: ModelCatalog,
): RuntimeProviderInstance {
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    !("provider" in result) ||
    !validateProviderV4(result.provider)
  ) {
    throw new Error("Invalid ProviderV4 runtime");
  }
  if ("raw" in result && result.raw !== undefined && typeof result.raw !== "function") {
    throw new PluginRawResolverError();
  }
  const raw =
    "raw" in result && typeof result.raw === "function" ? rawCapability(result.raw as RawResolver, catalog) : undefined;
  const providerTools = providerToolCapability(Reflect.get(result, "providerTools"));
  const supportedProviderTools = new Set(providerTools?.supported);
  const tokenCount = tokenCountCapability(Reflect.get(result, "tokenCount"));
  return {
    id: config.id,
    kind: ProviderKind.OAuth,
    enabled: config.enabled,
    models: catalog.language.map(({ id }) => id),
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    modelMetadata: modelMetadata(catalog),
    plugin: config.plugin,
    capability: config.capability,
    ...(raw === undefined ? {} : { raw }),
    ...(tokenCount === undefined ? {} : { tokenCount }),
    model: {
      invoke: createProviderV4Invoke(config.id, result.provider),
      supportsProviderTool: (type) => supportedProviderTools.has(type),
    },
  };
}

function tokenCountCapability(value: unknown): TokenCountCapability | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid token count capability");
  }
  const countTokens = Reflect.get(value, "countTokens");
  if (typeof countTokens !== "function") throw new Error("Invalid token count capability");
  return { countTokens: (input) => countTokens.call(value, input) };
}

const providerToolTypes: ReadonlySet<ProviderExecutedTool["type"]> = new Set(["web-search"]);

function providerToolCapability(value: unknown): ProviderToolCapability | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid provider tool capability");
  }
  const supported = Reflect.get(value, "supported");
  if (
    !Array.isArray(supported) ||
    !supported.every((type) => providerToolTypes.has(type as ProviderExecutedTool["type"]))
  ) {
    throw new Error("Invalid provider tool capability");
  }
  return { supported } as ProviderToolCapability;
}
