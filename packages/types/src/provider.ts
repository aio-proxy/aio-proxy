import { z } from "zod";
import { ModelEntrySchema } from "./common";

export enum ProviderKind {
  Api = "api",
  OAuth = "oauth",
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

const BaseProviderSchema = {
  id: z.string().describe("Stable provider id used in routing."),
  enabled: z.boolean().default(true).describe("Whether this provider participates in routing."),
  weight: z.number().optional().describe("Provider priority; higher weights are tried first."),
} as const;

export const ApiProviderSchema = z.object({
  kind: z.literal(ProviderKind.Api).describe("Provider backed by a raw HTTP API."),
  ...BaseProviderSchema,
  name: z.string().optional().describe("Display name shown in the dashboard."),
  protocol: ProviderProtocolSchema,
  baseUrl: z.url().describe("Provider API base URL."),
  apiKey: z.string().optional().describe("Bearer token or API key for the provider."),
  models: z.array(ModelEntrySchema).optional().describe("Models or aliases exposed through this provider."),
});

export const OAuthProviderSchema = z.object({
  kind: z.literal(ProviderKind.OAuth).describe("Provider backed by a local OAuth account."),
  ...BaseProviderSchema,
  vendor: z.enum(["github-copilot", "openai-chatgpt"] as const).describe("OAuth vendor."),
  models: z.array(ModelEntrySchema).optional().describe("Models or aliases exposed through this provider."),
});

export const AiSdkProviderSchema = z.object({
  kind: z.literal(ProviderKind.AiSdk).describe("Provider loaded from an AI SDK provider package."),
  ...BaseProviderSchema,
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
  models: z.array(ModelEntrySchema).optional().describe("Models or aliases exposed through this provider."),
});

export const ProviderSchema = z.discriminatedUnion("kind", [
  ApiProviderSchema,
  OAuthProviderSchema,
  AiSdkProviderSchema,
]);

export type ApiProviderInput = z.input<typeof ApiProviderSchema>;
export type ApiProvider = z.output<typeof ApiProviderSchema>;
export type OAuthProviderInput = z.input<typeof OAuthProviderSchema>;
export type OAuthProvider = z.output<typeof OAuthProviderSchema>;
export type AiSdkProviderInput = z.input<typeof AiSdkProviderSchema>;
export type AiSdkProvider = z.output<typeof AiSdkProviderSchema>;
export type ProviderInput = z.input<typeof ProviderSchema>;
export type Provider = z.output<typeof ProviderSchema>;
