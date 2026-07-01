import type {
  Provider as ConfigProvider,
  ModelEntry,
  ProviderProtocol,
} from "@aio-proxy/types";
import type { AiSdkProviderInstance } from "./provider/ai-sdk";
import type { ApiProviderInstance } from "./provider/api";

export type {
  CallSettings,
  FilePart,
  JSONValue,
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
  writeOpenAIChatCompletion,
  writeOpenAIChatSSE,
} from "./egress/openai-chat";
export {
  type OpenAIResponsesResponse,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "./egress/openai-responses";
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
  GeminiInlineDataTooLargeError,
  parseGeminiGenerateContent,
  safeParseGeminiGenerateContent,
} from "./ingress/gemini-generate-content";
export {
  type OpenAIChatRequest,
  OpenAIChatRequestSchema,
  parseOpenAIChat,
} from "./ingress/openai-chat";
export {
  type OpenAIResponsesCustomTool,
  type OpenAIResponsesFunctionTool,
  type OpenAIResponsesInputMessage,
  type OpenAIResponsesParseResult,
  type OpenAIResponsesRequest,
  OpenAIResponsesRequestSchema,
  type OpenAIResponsesTextPart,
  type OpenAIResponsesTool,
  OpenAIResponsesUnsupportedFeatureError,
  parseOpenAIResponses,
  safeParseOpenAIResponses,
} from "./ingress/openai-responses";
export {
  findInstalledNpmPackage,
  NpmInstallError,
  NpmPackageEntrypointError,
  type NpmPackageInfo,
  NpmPackageJsonError,
  NpmPackageNameError,
  npmAdd,
  npmPackageCacheDir,
} from "./npm";
export {
  type InstalledNpmPackage,
  listInstalledNpmPackages,
} from "./npm-list";
export { NpmLockError } from "./npm-lock";
export {
  AiSdkProviderError,
  type AiSdkProviderFactoryOptions,
  type AiSdkProviderInstance,
  createAiSdkProvider,
} from "./provider/ai-sdk";
export {
  AiSdkProviderLoaderError,
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
} from "./provider/api";
export {
  type AnthropicMessagesFromModelMessages,
  type AnthropicMessagesModelMessages,
  AnthropicMessagesTransformError,
  type AnthropicModelMessage,
  anthropicMessagesToModelMessages,
  modelMessagesToAnthropicMessages,
} from "./transform/anthropic-messages";
export {
  type GeminiGenerateContentFromModelMessages,
  type GeminiGenerateContentModelMessages,
  type GeminiGenerateContentSettings,
  type GeminiGenerateContentTool,
  GeminiGenerateContentTransformError,
  geminiGenerateContentToModelMessages,
  modelMessagesToGeminiGenerateContent,
} from "./transform/gemini-generate-content";
export {
  type OpenAIChatFromModelMessages,
  type OpenAIChatModelMessages,
  OpenAIChatTransformError,
  type OpenAIChatTransformSettings,
  type OpenAIChatTransformTool,
  openaiChatToModelMessages,
} from "./transform/openai-chat";
export { modelMessagesToOpenAIChat } from "./transform/openai-chat-from-model";
export {
  modelMessagesToOpenAIResponses,
  type OpenAIResponsesFromModelMessages,
  type OpenAIResponsesModelMessages,
  type OpenAIResponsesProviderOptions,
  type OpenAIResponsesReasoningEffort,
  type OpenAIResponsesReasoningSummary,
  OpenAIResponsesTransformError,
  type OpenAIResponsesTransformSettings,
  type OpenAIResponsesTransformTool,
  openAIResponsesToModelMessages,
} from "./transform/openai-responses";

export type ProviderSummary = {
  readonly id: string;
  readonly protocol: ProviderProtocol;
};

export type ProviderInstance =
  | (ConfigProvider & { readonly id: string })
  | ApiProviderInstance
  | AiSdkProviderInstance;

export type RouterResolution<
  TProvider extends ProviderInstance = ProviderInstance,
> = {
  readonly provider: TProvider;
  readonly modelId: string;
};

type ModelRoute = {
  readonly alias: string;
  readonly modelId: string;
};

export class RouterModelNotFoundError extends Error {
  readonly code = "MODEL_NOT_FOUND";
  readonly status = 404;

  constructor(readonly model: string) {
    super(`Model not found: ${model}`);
    this.name = "RouterModelNotFoundError";
  }
}

export class RouterModelCollisionError extends Error {
  constructor(
    readonly alias: string,
    readonly firstProviderId: string,
    readonly secondProviderId: string,
  ) {
    super(
      `Model alias "${alias}" is exposed by both "${firstProviderId}" and "${secondProviderId}"`,
    );
    this.name = "RouterModelCollisionError";
  }
}

export class Router<TProvider extends ProviderInstance = ProviderInstance> {
  private readonly aliases = new Map<string, RouterResolution<TProvider>>();
  private readonly providerAliases = new Map<
    string,
    RouterResolution<TProvider>
  >();

  constructor(providers: readonly TProvider[]) {
    for (const provider of providers) {
      for (const model of provider.models ?? []) {
        this.addRoute(provider, modelRoute(model));
      }
    }
  }

  resolve(model: string): RouterResolution<TProvider> {
    const route =
      model.indexOf("/") > 0
        ? this.providerAliases.get(model)
        : this.aliases.get(model);

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
      throw new RouterModelCollisionError(
        model.alias,
        existingProviderRoute.provider.id,
        provider.id,
      );
    }

    const existingRoute = this.aliases.get(model.alias);
    if (
      existingRoute !== undefined &&
      existingRoute.provider.id !== provider.id
    ) {
      throw new RouterModelCollisionError(
        model.alias,
        existingRoute.provider.id,
        provider.id,
      );
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
