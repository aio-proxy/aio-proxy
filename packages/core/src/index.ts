import type { Provider as ConfigProvider, ModelEntry, ProviderProtocol } from "@aio-proxy/types";
import { RouterModelCollisionError, RouterModelNotFoundError } from "./error";
import type { AiSdkProviderInstance } from "./provider/ai-sdk";
import type { ApiProviderInstance } from "./provider/api";

export type {
  AiSdkLanguageModel,
  CallSettings,
  FilePart,
  JSONValue,
  LanguageModelV2,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  ModelMessage,
  TextPart,
  TextStreamPart,
  ToolSet,
} from "./ai-sdk-bridge";
export { jsonSchema } from "./ai-sdk-bridge";
export { writeAnthropicMessagesSSE } from "./egress/anthropic-messages";
export { type IngressError, toIngressError } from "./egress/error";
export {
  writeGeminiGenerateContentResponse,
  writeGeminiGenerateContentSSE,
} from "./egress/gemini-generate-content";
export {
  writeOpenAICompletionsResponse,
  writeOpenAICompletionsSSE,
} from "./egress/openai-completions";
export {
  type OpenAIResponsesResponse,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "./egress/openai-responses";
export {
  AioProxyError,
  AiSdkProviderError,
  AiSdkProviderLoaderError,
  AnthropicMessagesTransformError,
  DatabaseSchemaTooNewError,
  GeminiGenerateContentTransformError,
  GeminiInlineDataTooLargeError,
  MigrationHashMismatchError,
  NpmInstallError,
  NpmLockError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
  OpenAICompletionsTransformError,
  OpenAIResponsesTransformError,
  OpenAIResponsesUnsupportedFeatureError,
  ProviderNotInstalledError,
  RouterModelCollisionError,
  RouterModelNotFoundError,
} from "./error";
export {
  type AnthropicCacheControl,
  type AnthropicMessagesRequest,
  AnthropicMessagesRequestSchema,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  parseAnthropicMessages,
} from "./ingress/anthropic-messages";
export {
  type GeminiGenerateContentParseResult,
  type GeminiGenerateContentPart,
  type GeminiGenerateContentRequest,
  GeminiGenerateContentRequestSchema,
  parseGeminiGenerateContent,
  safeParseGeminiGenerateContent,
} from "./ingress/gemini-generate-content";
export {
  type OpenAICompletionsRequest,
  OpenAICompletionsRequestSchema,
  parseOpenAICompletions,
} from "./ingress/openai-completions";
export {
  type OpenAIResponsesCustomTool,
  type OpenAIResponsesFunctionTool,
  type OpenAIResponsesInputMessage,
  type OpenAIResponsesParseResult,
  type OpenAIResponsesRequest,
  OpenAIResponsesRequestSchema,
  type OpenAIResponsesTextPart,
  type OpenAIResponsesTool,
  parseOpenAIResponses,
  safeParseOpenAIResponses,
} from "./ingress/openai-responses";
export {
  findInstalledNpmPackage,
  type NpmPackageInfo,
  npmAdd,
  npmPackageCacheDir,
} from "./npm";
export {
  type InstalledNpmPackage,
  listInstalledNpmPackages,
} from "./npm-list";
export {
  type AiSdkProviderFactoryOptions,
  type AiSdkProviderInstance,
  createAiSdkProvider,
} from "./provider/ai-sdk";
export {
  type AiSdkProviderLoadOptions,
  BUNDLED_PROVIDER_PACKAGES,
  BUNDLED_PROVIDERS,
  type BundledAiSdkProviderPackage,
  type LoadedAiSdkProvider,
  loadAiSdkProvider,
} from "./provider/ai-sdk-loader";
export {
  type ApiProviderConfig,
  type ApiProviderFactoryOptions,
  type ApiProviderInstance,
  type ApiProviderTrace,
  type ApiProviderTraceSink,
  createApiProvider,
  resolveApiKey,
} from "./provider/api";
export { bridgeApiProviderToAiSdk } from "./provider/api-bridge";
export {
  type AnthropicMessagesFromModelMessages,
  type AnthropicMessagesModelMessages,
  type AnthropicModelMessage,
  anthropicMessagesToModelMessages,
  modelMessagesToAnthropicMessages,
} from "./transform/anthropic-messages";
export {
  type GeminiGenerateContentFromModelMessages,
  type GeminiGenerateContentModelMessages,
  type GeminiGenerateContentSettings,
  type GeminiGenerateContentTool,
  geminiGenerateContentToModelMessages,
  modelMessagesToGeminiGenerateContent,
} from "./transform/gemini-generate-content";
export {
  type OpenAICompletionsFromModelMessages,
  type OpenAICompletionsModelMessages,
  type OpenAICompletionsTransformSettings,
  type OpenAICompletionsTransformTool,
  openAICompletionsToModelMessages,
} from "./transform/openai-completions";
export { modelMessagesToOpenAICompletions } from "./transform/openai-completions-from-model";
export {
  modelMessagesToOpenAIResponses,
  type OpenAIResponsesFromModelMessages,
  type OpenAIResponsesModelMessages,
  type OpenAIResponsesProviderOptions,
  type OpenAIResponsesReasoningEffort,
  type OpenAIResponsesReasoningSummary,
  type OpenAIResponsesTransformSettings,
  type OpenAIResponsesTransformTool,
  openAIResponsesToModelMessages,
} from "./transform/openai-responses";

export type ProviderSummary = {
  readonly id: string;
  readonly protocol: ProviderProtocol;
};

export type ProviderInstance = (ConfigProvider & { readonly id: string }) | ApiProviderInstance | AiSdkProviderInstance;

export type RouterResolution<TProvider extends ProviderInstance = ProviderInstance> = {
  readonly provider: TProvider;
  readonly modelId: string;
};

type ModelRoute = {
  readonly alias: string;
  readonly modelId: string;
};

export class Router<TProvider extends ProviderInstance = ProviderInstance> {
  private readonly aliases = new Map<string, RouterResolution<TProvider>>();
  private readonly providerAliases = new Map<string, RouterResolution<TProvider>>();

  constructor(providers: readonly TProvider[]) {
    for (const provider of providers) {
      if (provider.enabled === false) {
        continue;
      }
      for (const model of provider.models ?? []) {
        this.addRoute(provider, modelRoute(model));
      }
    }
  }

  resolve(model: string): RouterResolution<TProvider> {
    const route = model.indexOf("/") > 0 ? this.providerAliases.get(model) : this.aliases.get(model);

    if (route === undefined) {
      throw new RouterModelNotFoundError(model);
    }

    return route;
  }

  private addRoute(provider: TProvider, model: ModelRoute): void {
    const route = { provider, modelId: model.modelId };
    const providerAlias = `${provider.id}/${model.alias}`;
    const existingProviderRoute = this.providerAliases.get(providerAlias);

    if (existingProviderRoute !== undefined) {
      throw new RouterModelCollisionError(model.alias, existingProviderRoute.provider.id, provider.id);
    }

    const existingRoute = this.aliases.get(model.alias);
    if (existingRoute !== undefined && existingRoute.provider.id !== provider.id) {
      throw new RouterModelCollisionError(model.alias, existingRoute.provider.id, provider.id);
    }

    this.providerAliases.set(providerAlias, route);
    this.aliases.set(model.alias, route);
  }
}

function modelRoute(model: ModelEntry): ModelRoute {
  if (typeof model === "string") {
    return { alias: model, modelId: model };
  }

  return { alias: model.alias, modelId: model.id };
}
