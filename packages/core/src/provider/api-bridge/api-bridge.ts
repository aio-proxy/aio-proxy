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
  ProviderProtocol.OpenAIVideo,
  ProviderProtocol.TypeSafeSystemOne,
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

/**
 * The AI SDK load options for an API provider's endpoint: credentials, base URL,
 * headers, and the per-protocol auth shaping that goes with them.
 *
 * Exported because every surface that loads a package on an API provider's behalf
 * needs the SAME shaping, not just the language bridge. Rebuilding the object
 * inline silently drops the bearer branch below, which authenticates correctly on
 * whichever surface kept it and 401s forever on the one that did not.
 *
 * Deliberately protocol-shaping only, with no package selection and no throw for
 * non-language protocols: callers that serve System One pick their own package,
 * and `bridgeMapping` is the one that rejects protocols it cannot bridge.
 */
export function apiEndpointLoadOptions(
  provider: ApiProvider,
  endpoint: NormalizedApiEndpoint,
): AiSdkProviderLoadOptions {
  const apiKey = resolveApiKey(provider.apiKey);
  const shared = {
    ...(apiKey === undefined ? {} : { apiKey }),
    baseURL: endpoint.baseURL,
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
  } satisfies AiSdkProviderLoadOptions;

  if (endpoint.protocol !== ProviderProtocol.Anthropic || endpoint.auth !== 'bearer') {
    return shared;
  }
  // @ai-sdk/anthropic rejects apiKey+authToken together; bearer endpoints hand the key over as authToken.
  const { apiKey: bearerToken, ...withoutApiKey } = shared;
  return { ...withoutApiKey, ...(bearerToken === undefined ? {} : { authToken: bearerToken }) };
}

function bridgeMapping(provider: ApiProvider, primary: NormalizedApiEndpoint, providerId: string): BridgeMapping {
  const options = apiEndpointLoadOptions(provider, primary);

  switch (primary.protocol) {
    case ProviderProtocol.OpenAICompatible:
      return { packageName: '@ai-sdk/openai-compatible', options: { ...options, name: providerId } };
    case ProviderProtocol.Anthropic:
      return { packageName: '@ai-sdk/anthropic', options };
    case ProviderProtocol.Gemini:
    case ProviderProtocol.GeminiInteractions:
      return { packageName: '@ai-sdk/google', options };
    case ProviderProtocol.OpenAIResponse:
      return { packageName: '@ai-sdk/openai', options, resolveModel: resolveOpenAIResponsesModel };
    case ProviderProtocol.OpenAIImage:
    case ProviderProtocol.OpenAIAudio:
    case ProviderProtocol.OpenAIVideo:
    case ProviderProtocol.TypeSafeSystemOne:
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
