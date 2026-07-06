import { z } from "zod";
import { AliasConfigSchema, ModelIdSchema } from "./common";

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

const ProviderModelsSchema = {
  models: z.array(ModelIdSchema).optional().describe("Upstream model ids available through this provider."),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
} as const;

export const ApiProviderSchema = z.object({
  kind: z.literal(ProviderKind.Api).describe("Provider backed by a raw HTTP API."),
  ...BaseProviderSchema,
  name: z.string().optional().describe("Display name shown in the dashboard."),
  protocol: ProviderProtocolSchema,
  baseUrl: z.url().describe("Provider API base URL."),
  apiKey: z.string().optional().describe("Bearer token or API key for the provider."),
  ...ProviderModelsSchema,
});

export const OAuthProviderSchema = z.object({
  kind: z.literal(ProviderKind.OAuth).describe("Provider backed by a local OAuth account."),
  ...BaseProviderSchema,
  vendor: z.literal("github-copilot").describe("OAuth vendor."),
  ...ProviderModelsSchema,
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
  ...ProviderModelsSchema,
});

export const ProviderSchema = z
  .discriminatedUnion("kind", [ApiProviderSchema, OAuthProviderSchema, AiSdkProviderSchema])
  .superRefine(validateAliasTargets);

export function validateAliasTargets(
  provider: {
    models?: string[] | undefined;
    alias?:
      | Record<
          string,
          {
            model: string;
            preserve: boolean;
            variants?: Record<string, { model: string; preserve: boolean }> | undefined;
          }
        >
      | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (provider.models === undefined || provider.alias === undefined) {
    return;
  }
  const models = new Set(provider.models);
  for (const [alias, config] of Object.entries(provider.alias)) {
    if (!models.has(config.model)) {
      ctx.addIssue({
        code: "custom",
        message: `Alias target "${config.model}" is not listed in models`,
        path: ["alias", alias, "model"],
      });
    }
    for (const [variant, target] of Object.entries(config.variants ?? {})) {
      if (!models.has(target.model)) {
        ctx.addIssue({
          code: "custom",
          message: `Alias variant target "${target.model}" is not listed in models`,
          path: ["alias", alias, "variants", variant, "model"],
        });
      }
    }
  }
}

export type ApiProviderInput = z.input<typeof ApiProviderSchema>;
export type ApiProvider = z.output<typeof ApiProviderSchema>;
export type OAuthProviderInput = z.input<typeof OAuthProviderSchema>;
export type OAuthProvider = z.output<typeof OAuthProviderSchema>;
export type AiSdkProviderInput = z.input<typeof AiSdkProviderSchema>;
export type AiSdkProvider = z.output<typeof AiSdkProviderSchema>;
export type ProviderInput = z.input<typeof ProviderSchema>;
export type Provider = z.output<typeof ProviderSchema>;
