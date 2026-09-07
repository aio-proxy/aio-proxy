import type { AiSdkProvider, ApiProvider, NormalizedApiEndpoint } from '@aio-proxy/types';
import { apiProviderEndpoints, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { AiSdkLanguageModel, LoadedAiSdkRuntimeProvider } from '../../ai-sdk-bridge';
import type { AiSdkProviderLoadOptions } from '../ai-sdk-loader/index';
import { type AiSdkProviderFactoryOptions, type AiSdkProviderInstance, createAiSdkProvider } from '../ai-sdk/index';
import { resolveApiKey } from '../api/index';

// Protocols that expose no language-model surface, so they can never be the
// endpoint a language bridge is built from.
const NON_LANGUAGE_PROTOCOLS: ReadonlySet<ProviderProtocol> = new Set([
  ProviderProtocol.OpenAIImage,
  ProviderProtocol.OpenAIAudio,
]);

/**
 * Whether any endpoint can back a language bridge. Callers that decide whether
 * to build an `apiBridge` MUST gate on this rather than re-deriving it, since
 * `bridgeApiProviderToAiSdk` throws when no language endpoint exists.
 */
export function hasLanguageBridgeEndpoint(endpoints: readonly NormalizedApiEndpoint[]): boolean {
  return languageBridgeEndpoint(endpoints) !== undefined;
}

type BridgeMapping = {
  readonly options: AiSdkProviderLoadOptions;
  readonly packageName: string;
  readonly resolveModel?: AiSdkProviderFactoryOptions['resolveModel'];
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
  const language = languageBridgeEndpoint(apiProviderEndpoints(provider));
  if (language === undefined) {
    throw new Error('Unsupported provider protocol: no language endpoint');
  }
  const providerId = provider.id;
  const mapping = bridgeMapping(provider, language, providerId);
  const synthesized = {
    kind: ProviderKind.AiSdk,
    enabled: provider.enabled,
    id: `${providerId}:bridge`,
    packageName: mapping.packageName,
    options: mapping.options,
    priority: provider.priority,
    weight: provider.weight,
    ...(provider.models === undefined ? {} : { models: provider.models }),
    ...(provider.alias === undefined ? {} : { alias: provider.alias }),
  } satisfies AiSdkProvider;

  return createAiSdkProvider(synthesized, {
    ...options,
    ...(mapping.resolveModel === undefined ? {} : { resolveModel: mapping.resolveModel }),
  });
}

function languageBridgeEndpoint(endpoints: readonly NormalizedApiEndpoint[]): NormalizedApiEndpoint | undefined {
  return endpoints.find((endpoint) => !NON_LANGUAGE_PROTOCOLS.has(endpoint.protocol));
}

function bridgeMapping(provider: ApiProvider, primary: NormalizedApiEndpoint, providerId: string): BridgeMapping {
  const apiKey = resolveApiKey(provider.apiKey);
  const sharedOptions = {
    ...(apiKey === undefined ? {} : { apiKey }),
    baseURL: primary.baseURL,
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
  } satisfies AiSdkProviderLoadOptions;

  switch (primary.protocol) {
    case ProviderProtocol.OpenAICompatible:
      return { packageName: '@ai-sdk/openai-compatible', options: { ...sharedOptions, name: providerId } };
    case ProviderProtocol.Anthropic: {
      if (primary.auth !== 'bearer') return { packageName: '@ai-sdk/anthropic', options: sharedOptions };
      // @ai-sdk/anthropic rejects apiKey+authToken together; bearer endpoints hand the key over as authToken.
      const { apiKey: bearerToken, ...withoutApiKey } = sharedOptions;
      return {
        packageName: '@ai-sdk/anthropic',
        options: { ...withoutApiKey, ...(bearerToken === undefined ? {} : { authToken: bearerToken }) },
      };
    }
    case ProviderProtocol.Gemini:
    case ProviderProtocol.GeminiInteractions:
      return { packageName: '@ai-sdk/google', options: sharedOptions };
    case ProviderProtocol.OpenAIResponse:
      return { packageName: '@ai-sdk/openai', options: sharedOptions, resolveModel: resolveOpenAIResponsesModel };
    case ProviderProtocol.OpenAIImage:
    case ProviderProtocol.OpenAIAudio:
      throw new Error(`Unsupported provider protocol: ${primary.protocol}`);
    default:
      return assertNever(primary.protocol);
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
  return hasRuntimeProviderMethods(provider) && typeof provider.responses === 'function';
}

function hasRuntimeProviderMethods(value: unknown): value is RuntimeProviderMethods {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider protocol: ${String(value)}`);
}
