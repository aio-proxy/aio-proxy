import type { ProviderProtocol } from "@aio-proxy/types";

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
export {
  type AnthropicMessageResponse,
  writeAnthropicMessagesResponse,
  writeAnthropicMessagesSSE,
} from "./egress/anthropic-messages";
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
export { aioHome, configPath, dbPath, logPath, packagesDir, pidPath } from "./paths";
export * from "./protocol";
export {
  type AiSdkProviderFactoryOptions,
  type AiSdkProviderInstance,
  createAiSdkProvider,
} from "./provider/ai-sdk";
export {
  type AiSdkProviderLoadOptions,
  BUNDLED_PROVIDER_PACKAGES,
  BUNDLED_PROVIDER_VERSIONS,
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
export { bridgeApiProviderToAiSdk, resolveOpenAIResponsesModel } from "./provider/api-bridge";
export {
  type ModelRoute,
  modelRoutes,
  type ProviderInstance,
  Router,
  type RouterCandidate,
  type RouterResolution,
} from "./router";
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
export {
  calculateEstimatedCost,
  createModelsDevCatalog,
  createOpenRouterPriceCatalog,
  type FetchModelsDevProviders,
  type FetchOpenRouterPrices,
  type ModelsDevCapabilities,
  type ModelsDevCatalog,
  type ModelsDevModelMetadata,
  type OpenRouterModelPrice,
  type OpenRouterPriceCatalog,
  type UsageCostResult,
  type UsagePricingInput,
} from "./usage-pricing";

export type ProviderSummary = {
  readonly id: string;
  readonly protocol: ProviderProtocol;
};
