import { z } from "zod";
import { AliasConfigSchema, ModelIdSchema, normalizeAliasName, normalizeVariantKey } from "./common";
import { type ProviderAlias, validateAliasTargets } from "./provider-alias";

export { validateAliasTargets } from "./provider-alias";

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

export enum OAuthVendor {
  GitHubCopilot = "github-copilot",
  OpenAIChatGPT = "openai-chatgpt",
}

export const ProviderProtocolSchema = z
  .enum(ProviderProtocol)
  .describe("Wire protocol supported by this provider base URL.");

const SharedProviderSchemaBase = {
  id: z.string().describe("Stable provider id used in routing."),
  enabled: z.boolean().default(true).describe("Whether this provider participates in routing."),
  weight: z.number().optional().describe("Provider priority; higher weights are tried first."),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
  name: z.string().optional().describe("Display name shown in the dashboard."),
} as const;

const modelsField = {
  models: z.array(ModelIdSchema).optional().describe("Upstream model ids available through this provider."),
} as const;

export const ApiProviderSchema = z.object({
  kind: z.literal(ProviderKind.Api).describe("Provider backed by a raw HTTP API."),
  ...SharedProviderSchemaBase,
  ...modelsField,
  protocol: ProviderProtocolSchema,
  baseUrl: z.url().describe("Provider API base URL."),
  apiKey: z.string().optional().describe("Bearer token or API key for the provider."),
});

export const OAuthProviderSchema = z.object({
  kind: z.literal(ProviderKind.OAuth).describe("Provider backed by a local OAuth account."),
  ...SharedProviderSchemaBase,
  vendor: z.enum(OAuthVendor).describe("OAuth vendor."),
});

export const AiSdkProviderSchema = z.object({
  kind: z.literal(ProviderKind.AiSdk).describe("Provider loaded from an AI SDK provider package."),
  ...SharedProviderSchemaBase,
  ...modelsField,
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
});

// ── Mutation body schemas (POST/PUT) ───────────────────────────────────────────
// id is REQUIRED on both POST and PUT. apiKey uses "" → retain semantics server-side.
export const ApiProviderMutationBodySchema = z.object({
  kind: z.literal(ProviderKind.Api),
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().optional(),
  protocol: ProviderProtocolSchema,
  baseUrl: z.url(),
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
});

export const AiSdkProviderMutationBodySchema = z.object({
  kind: z.literal(ProviderKind.AiSdk),
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().optional(),
  packageName: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  parseReasoningContent: z.boolean().optional(),
  models: z.array(z.string()).optional(),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
});

export const ProviderMutationBodySchema = z
  .discriminatedUnion("kind", [ApiProviderMutationBodySchema, AiSdkProviderMutationBodySchema])
  .superRefine(validateAliasTargets)
  .transform((provider) =>
    provider.alias === undefined ? provider : { ...provider, alias: normalizeAliasKeys(provider.alias) },
  );

type ProviderValue =
  | z.output<typeof ApiProviderSchema>
  | z.output<typeof OAuthProviderSchema>
  | z.output<typeof AiSdkProviderSchema>;
export const ProviderSchema = z
  .discriminatedUnion("kind", [ApiProviderSchema, OAuthProviderSchema, AiSdkProviderSchema])
  .superRefine(validateAliasTargets)
  .transform(normalizeProviderAlias);

function normalizeProviderAlias(provider: ProviderValue): ProviderValue {
  if (provider.alias === undefined) {
    return provider;
  }
  const alias = normalizeAliasPreserve(normalizeAliasKeys(provider.alias));
  return alias === provider.alias ? provider : { ...provider, alias };
}

function normalizeAliasKeys(alias: ProviderAlias): ProviderAlias {
  return Object.fromEntries(
    Object.entries(alias).map(([name, config]) => [
      normalizeAliasName(name),
      config.variants === undefined
        ? config
        : {
            ...config,
            variants: Object.fromEntries(
              Object.entries(config.variants).map(([variant, target]) => [normalizeVariantKey(variant), target]),
            ),
          },
    ]),
  );
}

function normalizeAliasPreserve(alias: ProviderAlias): ProviderAlias {
  let changed = false;
  const normalized: Record<string, ProviderAlias[string]> = {};
  for (const [clientModel, config] of Object.entries(alias)) {
    const selfAlias = alias[config.model];
    if (config.preserve && clientModel !== config.model && selfAlias?.model === config.model) {
      normalized[clientModel] = { ...config, preserve: false };
      changed = true;
      continue;
    }
    normalized[clientModel] = config;
  }
  return changed ? normalized : alias;
}

export type ApiProviderInput = z.input<typeof ApiProviderSchema>;
export type ApiProvider = z.output<typeof ApiProviderSchema>;
export type OAuthProviderInput = z.input<typeof OAuthProviderSchema>;
export type OAuthProvider = z.output<typeof OAuthProviderSchema>;
export type AiSdkProviderInput = z.input<typeof AiSdkProviderSchema>;
export type AiSdkProvider = z.output<typeof AiSdkProviderSchema>;
export type ApiProviderMutationBodyInput = z.input<typeof ApiProviderMutationBodySchema>;
export type ApiProviderMutationBody = z.output<typeof ApiProviderMutationBodySchema>;
export type AiSdkProviderMutationBodyInput = z.input<typeof AiSdkProviderMutationBodySchema>;
export type AiSdkProviderMutationBody = z.output<typeof AiSdkProviderMutationBodySchema>;
export type ProviderMutationBodyInput = z.input<typeof ProviderMutationBodySchema>;
export type ProviderMutationBody = z.output<typeof ProviderMutationBodySchema>;
export type ProviderInput = z.input<typeof ProviderSchema>;
export type Provider = z.output<typeof ProviderSchema>;
