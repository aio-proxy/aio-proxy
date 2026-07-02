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

export const ProviderProtocolSchema = z.enum(ProviderProtocol);

export const ApiProviderSchema = z.object({
  kind: z.literal(ProviderKind.Api),
  id: z.string().optional(),
  name: z.string().optional(),
  protocol: ProviderProtocolSchema,
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  models: z.array(ModelEntrySchema).optional(),
});

export const SubscriptionProviderSchema = z.object({
  kind: z.literal(ProviderKind.Subscription),
  id: z.string(),
  vendor: z.literal("github-copilot"),
  models: z.array(ModelEntrySchema).optional(),
});

export const AiSdkProviderSchema = z.object({
  kind: z.literal(ProviderKind.AiSdk),
  id: z.string(),
  packageName: z.string().default("@ai-sdk/openai-compatible"),
  providerName: z.string().optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  parseReasoningContent: z.boolean().optional(),
  models: z.array(ModelEntrySchema).optional(),
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
