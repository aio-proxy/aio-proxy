import type { ProviderProtocol } from '@aio-proxy/types';

export {
  AgentInstallationTargetMismatchError,
  createAgentIdentityService,
  type AgentAccessAuthentication,
  type AgentAccessGrant,
  type AgentCredentialIssueInput,
  type AgentIdentityService,
  type AgentRefreshInput,
  type AgentRefreshResult,
  type AgentRefreshSuccess,
  type IssuedAgentCredential,
} from './agent-identity';
export type {
  AiSdkLanguageModel,
  AiSdkCallSettings,
  FilePart,
  JSONValue,
  LanguageModelV2,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  ModelMessage,
  TextPart,
  TextStreamPart,
  ToolSet,
} from './ai-sdk-bridge';
export { jsonSchema } from './ai-sdk-bridge';
export { fileCacheStorage } from './cache/index';
export { parseRuntimeConfig, resolveConfigTemplates } from './config/index';
export {
  type AnthropicMessageResponse,
  writeAnthropicMessagesResponse,
  writeAnthropicMessagesSSE,
} from './egress/anthropic-messages';
export { writeGeminiGenerateContentResponse, writeGeminiGenerateContentSSE } from './egress/gemini-generate-content';
export { writeOpenAICompletionsResponse, writeOpenAICompletionsSSE } from './egress/openai-completions';
export {
  type OpenAIResponsesResponse,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from './egress/openai-responses/index';
export {
  AioProxyError,
  AiSdkProviderError,
  AiSdkProviderLoaderError,
  AnthropicMessagesTransformError,
  DatabaseSchemaTooNewError,
  GeminiGenerateContentTransformError,
  GeminiInteractionsTransformError,
  GeminiInteractionsUnsupportedFeatureError,
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
} from './error';

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
} from './image-input';
export {
  type AnthropicCacheControl,
  type AnthropicImageBlock,
  type AnthropicMessagesRequest,
  AnthropicMessagesRequestSchema,
  type AnthropicTextBlock,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  parseAnthropicMessages,
} from './ingress/anthropic-messages/index';
export {
  type GeminiGenerateContentParseResult,
  type GeminiGenerateContentPart,
  type GeminiGenerateContentRequest,
  GeminiGenerateContentRequestSchema,
  parseGeminiGenerateContent,
  safeParseGeminiGenerateContent,
} from './ingress/gemini-generate-content/index';
export {
  type GeminiInteractionsBody,
  type GeminiInteractionsParseResult,
  type GeminiInteractionsRequest,
  parseGeminiInteractions,
  safeParseGeminiInteractions,
} from './ingress/gemini-interactions/index';
export {
  type OpenAICompletionsRequest,
  OpenAICompletionsRequestSchema,
  parseOpenAICompletions,
} from './ingress/openai-completions';
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
} from './ingress/openai-responses/index';
export type { Model as ModelsDevModel } from '@opencode-ai/models';
export {
  catalogModelToMetadata,
  clearModelsCache,
  findModelPrice,
  getCachedModelSlugs,
  getModels,
  getModelsCachedOnly,
  hasCachedModelsCatalog,
  getProviders,
} from './models-dev/index';
export { modelEffortValues, normalizeEffort } from './protocol/reasoning-effort/index';
export {
  findInstalledNpmPackage,
  isNpmPackageName,
  type NpmPackageInfo,
  npmAdd,
  npmPackageCacheDir,
  removeNpmPackageCache,
  withInstalledNpmPackage,
  withNpmPackageLifecycle,
} from './npm';
export { type InstalledNpmPackage, listInstalledNpmPackages } from './npm-list';
export { canonicalizeLoopbackHost } from './network/index';
export { aioHome, configPath, dbPath, packagesDir } from './paths/index';
export * from './plugins';
export * from './protocol';
export {
  type AiSdkProviderFactoryOptions,
  type AiSdkProviderInstance,
  createAiSdkProvider,
} from './provider/ai-sdk/index';
export {
  type AiSdkProviderLoadOptions,
  BUNDLED_PROVIDER_PACKAGES,
  BUNDLED_PROVIDER_VERSIONS,
  BUNDLED_PROVIDERS,
  type BundledAiSdkProviderPackage,
  isAiSdkProviderModule,
  type LoadedAiSdkProvider,
  loadAiSdkProvider,
} from './provider/ai-sdk-loader/index';
export {
  type ApiEndpointTransport,
  type ApiProviderConfig,
  type ApiProviderFactoryOptions,
  type ApiProviderInstance,
  type ApiProviderTrace,
  type ApiProviderTraceSink,
  createApiProvider,
  resolveApiKey,
} from './provider/api/index';
export { bridgeApiProviderToAiSdk, resolveOpenAIResponsesModel } from './provider/api-bridge/index';
export { createProviderV4Invoke, validateProviderV4 } from './provider/provider-v4';
export { createProxyFetch, type ProviderFetch } from './provider/proxy-fetch';
export {
  type EffectiveCandidateRouting,
  type ModelRoute,
  modelRoutes,
  type ProviderInstance,
  type RoutableProvider,
  Router,
  type RouterCandidate,
  type RouterCatalogCandidate,
  type RouterOptions,
  type RouterResolution,
  type RouterResolveOptions,
  type RouterSelectionSource,
  type RoutingValueSource,
} from './router';
export {
  type AnthropicMessagesFromModelMessages,
  type AnthropicMessagesModelMessages,
  type AnthropicModelMessage,
  anthropicMessagesToModelMessages,
  modelMessagesToAnthropicMessages,
} from './transform/anthropic-messages/index';
export {
  type GeminiGenerateContentFromModelMessages,
  type GeminiGenerateContentModelMessages,
  type GeminiGenerateContentSettings,
  type GeminiGenerateContentTool,
  geminiGenerateContentToModelMessages,
  modelMessagesToGeminiGenerateContent,
} from './transform/gemini-generate-content/index';
export {
  type GeminiInteractionsModelMessages,
  type GeminiInteractionsTransformSettings,
  type GeminiInteractionsTransformTool,
  geminiInteractionsToModelMessages,
} from './transform/gemini-interactions/index';
export {
  type OpenAICompletionsFromModelMessages,
  type OpenAICompletionsModelMessages,
  type OpenAICompletionsTransformSettings,
  type OpenAICompletionsTransformTool,
  modelMessagesToOpenAICompletions,
  openAICompletionsToModelMessages,
} from './transform/openai-completions/index';
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
} from './transform/openai-responses/index';
export {
  calculateEstimatedCost,
  configModelPrice,
  type OpenRouterModelPrice,
  type OpenRouterModelPriceTier,
  tierAdjustedPrice,
  type UsageAccounting,
  type UsageCostResult,
  type UsagePricingInput,
} from './usage-pricing';
export { COST_SCALE, nanoUsdToUsd, parseSqliteInteger, usdToNanoUsd } from './usage-numbers';

export type ProviderSummary = {
  readonly id: string;
  readonly protocol: ProviderProtocol;
};
