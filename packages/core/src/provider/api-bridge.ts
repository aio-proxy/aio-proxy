import type { AiSdkProvider, ApiProvider } from "@aio-proxy/types";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import type { AiSdkLanguageModel, LoadedAiSdkRuntimeProvider } from "../ai-sdk-bridge";
import { type AiSdkProviderFactoryOptions, type AiSdkProviderInstance, createAiSdkProvider } from "./ai-sdk";
import type { AiSdkProviderLoadOptions } from "./ai-sdk-loader";
import { resolveApiKey } from "./api";

type BridgeMapping = {
  readonly options: AiSdkProviderLoadOptions;
  readonly packageName: string;
  readonly resolveModel?: AiSdkProviderFactoryOptions["resolveModel"];
};

type RuntimeProviderMethods = {
  readonly responses?: unknown;
};

type ResponsesProvider = {
  readonly responses: (modelId: string) => AiSdkLanguageModel;
};

export function bridgeApiProviderToAiSdk(
  provider: ApiProvider,
  options: AiSdkProviderFactoryOptions = {},
): AiSdkProviderInstance {
  const baseURL = provider.baseUrl;
  const providerId = provider.id;
  const mapping = bridgeMapping(provider, baseURL, providerId);
  const synthesized = {
    kind: ProviderKind.AiSdk,
    enabled: provider.enabled,
    id: `${providerId}:bridge`,
    packageName: mapping.packageName,
    options: mapping.options,
    ...(provider.models === undefined ? {} : { models: provider.models }),
    ...(provider.alias === undefined ? {} : { alias: provider.alias }),
  } satisfies AiSdkProvider;

  return createAiSdkProvider(synthesized, {
    ...options,
    ...(mapping.resolveModel === undefined ? {} : { resolveModel: mapping.resolveModel }),
  });
}

function bridgeMapping(provider: ApiProvider, baseURL: string, providerId: string): BridgeMapping {
  const apiKey = resolveApiKey(provider.apiKey);
  const sharedOptions = {
    ...(apiKey === undefined ? {} : { apiKey }),
    baseURL,
  } satisfies AiSdkProviderLoadOptions;

  switch (provider.protocol) {
    case ProviderProtocol.OpenAICompatible:
      return {
        packageName: "@ai-sdk/openai-compatible",
        options: {
          ...sharedOptions,
          name: providerId,
        },
      };
    case ProviderProtocol.Anthropic:
      return {
        packageName: "@ai-sdk/anthropic",
        options: sharedOptions,
      };
    case ProviderProtocol.Gemini:
      return {
        packageName: "@ai-sdk/google",
        options: sharedOptions,
      };
    case ProviderProtocol.OpenAIResponse:
      return {
        packageName: "@ai-sdk/openai",
        options: sharedOptions,
        resolveModel: resolveOpenAIResponsesModel,
      };
    default:
      return assertNever(provider.protocol);
  }
}

export function resolveOpenAIResponsesModel(
  _config: AiSdkProvider,
  modelId: string,
  provider: LoadedAiSdkRuntimeProvider | null,
): AiSdkLanguageModel | undefined {
  if (!hasResponses(provider)) {
    return undefined;
  }

  return provider.responses(modelId);
}

function hasResponses(provider: unknown): provider is ResponsesProvider {
  return hasRuntimeProviderMethods(provider) && typeof provider.responses === "function";
}

function hasRuntimeProviderMethods(value: unknown): value is RuntimeProviderMethods {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider protocol: ${String(value)}`);
}
