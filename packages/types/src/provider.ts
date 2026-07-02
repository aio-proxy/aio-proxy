import { z } from "zod";
import { ModelEntrySchema } from "./common";

export enum ProviderKind {
  Api = "api",
  Subscription = "subscription",
  AiSdk = "ai-sdk",
}

export enum ProviderProtocol {
  OpenAIResponse = "openai-response",
  OpenAICompatible = "openai-compatible",
  Anthropic = "anthropic",
  Gemini = "gemini",
}

export const ProviderProtocolSchema = z
  .enum(ProviderProtocol)
  .describe("Wire protocol supported by this provider base URL.");

export const ApiProviderSchema = z.object({
  kind: z
    .literal(ProviderKind.Api)
    .describe("Provider backed by a raw HTTP API."),
  id: z.string().optional().describe("Stable provider id used in routing."),
  name: z.string().optional().describe("Display name shown in the dashboard."),
  protocol: ProviderProtocolSchema,
  baseUrl: z.url().optional().describe("Provider API base URL."),
  apiKey: z
    .string()
    .optional()
    .describe("Bearer token or API key for the provider."),
  models: z
    .array(ModelEntrySchema)
    .optional()
    .describe("Models or aliases exposed through this provider."),
});

export const SubscriptionProviderSchema = z.object({
  kind: z
    .literal(ProviderKind.Subscription)
    .describe("Provider backed by a local subscription account."),
  id: z.string().describe("Stable provider id used in routing."),
  vendor: z.literal("github-copilot").describe("Subscription vendor."),
  models: z
    .array(ModelEntrySchema)
    .optional()
    .describe("Models or aliases exposed through this provider."),
});

export const AiSdkProviderSchema = z.object({
  kind: z
    .literal(ProviderKind.AiSdk)
    .describe("Provider loaded from an AI SDK provider package."),
  id: z.string().describe("Stable provider id used in routing."),
  packageName: z
    .string()
    .default("@ai-sdk/openai-compatible")
    .describe("npm package name that exports the AI SDK provider factory."),
  options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Options passed through to the AI SDK provider package."),
  parseReasoningContent: z
    .boolean()
    .optional()
    .describe("Parse reasoning content from OpenAI-compatible stream chunks."),
  models: z
    .array(ModelEntrySchema)
    .optional()
    .describe("Models or aliases exposed through this provider."),
});

export const ProviderSchema = z.discriminatedUnion("kind", [
  ApiProviderSchema,
  SubscriptionProviderSchema,
  AiSdkProviderSchema,
]);

export type ApiProviderInput = z.input<typeof ApiProviderSchema>;
export type ApiProvider = z.output<typeof ApiProviderSchema>;
export type SubscriptionProviderInput = z.input<
  typeof SubscriptionProviderSchema
>;
export type SubscriptionProvider = z.output<typeof SubscriptionProviderSchema>;
export type AiSdkProviderInput = z.input<typeof AiSdkProviderSchema>;
export type AiSdkProvider = z.output<typeof AiSdkProviderSchema>;
export type ProviderInput = z.input<typeof ProviderSchema>;
export type Provider = z.output<typeof ProviderSchema>;
