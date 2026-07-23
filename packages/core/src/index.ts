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
export { parseRuntimeConfig, resolveConfigTemplates } from "./config/index";
export {
  type AnthropicMessageResponse,
  writeAnthropicMessagesResponse,
  writeAnthropicMessagesSSE,
} from "./egress/anthropic-messages";
export { writeGeminiGenerateContentResponse, writeGeminiGenerateContentSSE } from "./egress/gemini-generate-content";
export { writeOpenAICompletionsResponse, writeOpenAICompletionsSSE } from "./egress/openai-completions";
export {
  type OpenAIResponsesResponse,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "./egress/openai-responses/index";
export {
  AioProxyError,
  AiSdkProviderError,
  AiSdkProviderLoaderError,
  AnthropicMessagesTransformError,
  DatabaseSchemaTooNewError,
  GeminiGenerateContentTransformError,
  GeminiInlineDataTooLargeError,
  ImageInputUnsupportedError,
  type ImageInputUnsupportedReason,
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
  assertImageInputSupported,
  imageFilePart,
  imageTargetProtocolForPackage,
  type ImageFilePartOptions,
  type ImageFileSource,
  type ImageInputDetail,
  isHttpUrl,
  isImageMediaType,
  isValidBase64,
} from "./image-input";
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
  type OpenAIResponsesExecutableTool,
  type OpenAIResponsesFunctionTool,
  type OpenAIResponsesInputMessage,
  type OpenAIResponsesNamespaceTool,
  type OpenAIResponsesParseResult,
  type OpenAIResponsesRequest,
  OpenAIResponsesRequestSchema,
  type OpenAIResponsesTextPart,
  type OpenAIResponsesTool,
  type OpenAIResponsesToolOutputPart,
  type OpenAIResponsesUnsupportedInputItem,
  type OpenAIResponsesUnsupportedTool,
  parseOpenAIResponses,
  safeParseOpenAIResponses,
} from "./ingress/openai-responses/index";
export {
  createModelsDevCatalog,
  createOpenRouterPriceCatalog,
  type FetchModelsDevProviders,
  type FetchOpenRouterPrices,
  type ModelsDevCapabilities,
  type ModelsDevCatalog,
  type ModelsDevModelMetadata,
  type OpenRouterPriceCatalog,
} from "./models-dev-catalog";
export {
  findInstalledNpmPackage,
  isNpmPackageName,
  type NpmPackageInfo,
  npmAdd,
  npmPackageCacheDir,
  removeNpmPackageCache,
  withInstalledNpmPackage,
  withNpmPackageLifecycle,
} from "./npm";
export { type InstalledNpmPackage, listInstalledNpmPackages } from "./npm-list";
export { aioHome, configPath, dbPath, logPath, packagesDir, pidPath } from "./paths/index";
export * from "./plugins";
export * from "./protocol";
export {
  type AiSdkProviderFactoryOptions,
  type AiSdkProviderInstance,
  createAiSdkProvider,
} from "./provider/ai-sdk/index";
export {
  type AiSdkProviderLoadOptions,
  BUNDLED_PROVIDER_PACKAGES,
  BUNDLED_PROVIDER_VERSIONS,
  BUNDLED_PROVIDERS,
  type BundledAiSdkProviderPackage,
  type LoadedAiSdkProvider,
  loadAiSdkProvider,
} from "./provider/ai-sdk-loader/index";
export {
  type ApiProviderConfig,
  type ApiProviderFactoryOptions,
  type ApiProviderInstance,
  type ApiProviderTrace,
  type ApiProviderTraceSink,
  createApiProvider,
  resolveApiKey,
} from "./provider/api/index";
export { bridgeApiProviderToAiSdk, resolveOpenAIResponsesModel } from "./provider/api-bridge/index";
export { createProviderV4Invoke, validateProviderV4 } from "./provider/provider-v4";
export { createProxyFetch, type ProviderFetch } from "./provider/proxy-fetch";
export {
  type ModelRoute,
  modelRoutes,
  type ProviderInstance,
  type RoutableProvider,
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
  modelMessagesToOpenAICompletions,
  openAICompletionsToModelMessages,
} from "./transform/openai-completions";
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
  type OpenRouterModelPrice,
  type UsageAccounting,
  type UsageCostResult,
  type UsagePricingInput,
} from "./usage-pricing";

export type ProviderSummary = {
  readonly id: string;
  readonly protocol: ProviderProtocol;
};
