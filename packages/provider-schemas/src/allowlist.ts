export const PROVIDER_SCHEMA_ALLOWLIST = [
  { packageName: "@ai-sdk/openai", factoryName: "createOpenAI" },
  { packageName: "@ai-sdk/anthropic", factoryName: "createAnthropic" },
  { packageName: "@ai-sdk/google", factoryName: "createGoogle" },
  { packageName: "@ai-sdk/openai-compatible", factoryName: "createOpenAICompatible" },
  { packageName: "@ai-sdk/mistral", factoryName: "createMistral" },
  { packageName: "@ai-sdk/groq", factoryName: "createGroq" },
  { packageName: "@ai-sdk/xai", factoryName: "createXai" },
  { packageName: "@openrouter/ai-sdk-provider", factoryName: "createOpenRouter" },
] as const;

export type ProviderSchemaAllowlistEntry = (typeof PROVIDER_SCHEMA_ALLOWLIST)[number];
