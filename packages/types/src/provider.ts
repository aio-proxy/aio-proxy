import { z } from "zod";

import { AliasConfigSchema, ModelIdSchema, normalizeAliasName, normalizeVariantKey } from "./common";
import { CapabilityIdSchema, PluginPackageNameSchema } from "./plugin";
import { type ProviderAlias, validateAliasTargets } from "./provider-alias";

export { type ProviderAlias, validateAliasTargets } from "./provider-alias";

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

/** Authoring-only string that still contains an unresolved `{{env.NAME}}` template. */
export const ConfigTemplateStringSchema = z.string().regex(/\{\{[\s\S]*\}\}/u, "Expected a config template");

export const HttpProxyUrlSchema = z.url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "Proxy URL must use http: or https:");

const ProviderProxySchema = z.union([HttpProxyUrlSchema, z.literal(false)]).optional();
const AuthoringProviderProxySchema = z
  .union([HttpProxyUrlSchema, ConfigTemplateStringSchema, z.literal(false)])
  .optional();
const PROXY_DESCRIPTION = "HTTP(S) proxy URL; inherits the top-level proxy when omitted, false disables it.";

const ApiHeadersSchema = z
  .record(z.string(), z.string())
  .superRefine((headers, context) => {
    try {
      new Headers(headers);
    } catch (error) {
      context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid headers" });
    }
  })
  .readonly();

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

const AiSdkPackageNameSchema = z.string().trim().min(1, "AI SDK package name cannot be blank");

const ApiProviderSharedFields = {
  kind: z.literal(ProviderKind.Api).describe("Provider backed by a raw HTTP API."),
  ...SharedProviderSchemaBase,
  ...modelsField,
  protocol: ProviderProtocolSchema,
  apiKey: z.string().optional().describe("Bearer token or API key for the provider."),
  headers: ApiHeadersSchema.optional().describe("Headers applied to upstream requests; configured values win."),
} as const;

export const ApiProviderSchema = z.object({
  ...ApiProviderSharedFields,
  baseURL: z.url().describe("Provider API base URL."),
  proxy: ProviderProxySchema.describe(PROXY_DESCRIPTION),
});

export const ApiProviderAuthoringSchema = ApiProviderSchema.omit({ baseURL: true, proxy: true, protocol: true }).extend(
  {
    protocol: z.union([ProviderProtocolSchema, ConfigTemplateStringSchema]),
    baseURL: z.union([z.url(), ConfigTemplateStringSchema]).describe("Provider API base URL."),
    proxy: AuthoringProviderProxySchema.describe(PROXY_DESCRIPTION),
  },
);

export const OAuthPluginProviderSchema = z.object({
  kind: z.literal(ProviderKind.OAuth).describe("Provider backed by a plugin OAuth account."),
  ...SharedProviderSchemaBase,
  plugin: PluginPackageNameSchema,
  capability: CapabilityIdSchema,
  options: z.record(z.string(), z.unknown()).optional(),
});

export const OAuthProviderSchema = OAuthPluginProviderSchema;

export const OAuthProviderAuthoringSchema = OAuthProviderSchema.omit({ plugin: true, capability: true }).extend({
  plugin: z.union([PluginPackageNameSchema, ConfigTemplateStringSchema]),
  capability: z.union([CapabilityIdSchema, ConfigTemplateStringSchema]),
});

const AiSdkProviderSharedFields = {
  kind: z.literal(ProviderKind.AiSdk).describe("Provider loaded from an AI SDK provider package."),
  ...SharedProviderSchemaBase,
  ...modelsField,
  packageName: AiSdkPackageNameSchema.default("@ai-sdk/openai-compatible").describe(
    "npm package name that exports the AI SDK provider factory.",
  ),
  options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Options passed through to the AI SDK provider package."),
  parseReasoningContent: z
    .boolean()
    .optional()
    .describe("Parse reasoning content from OpenAI-compatible stream chunks."),
} as const;

export const AiSdkProviderSchema = z.object({
  ...AiSdkProviderSharedFields,
  proxy: ProviderProxySchema.describe(PROXY_DESCRIPTION),
});

export const AiSdkProviderAuthoringSchema = AiSdkProviderSchema.omit({ proxy: true, packageName: true }).extend({
  packageName: z
    .union([AiSdkPackageNameSchema, ConfigTemplateStringSchema])
    .default("@ai-sdk/openai-compatible")
    .describe("npm package name that exports the AI SDK provider factory."),
  proxy: AuthoringProviderProxySchema.describe(PROXY_DESCRIPTION),
});

// ── Mutation body schemas (POST/PUT) ───────────────────────────────────────────
// id is REQUIRED on both POST and PUT. apiKey uses "" → retain semantics server-side.
const ApiProviderMutationSharedFields = {
  kind: z.literal(ProviderKind.Api),
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().optional(),
  protocol: ProviderProtocolSchema,
  apiKey: z.string().optional(),
  headers: ApiHeadersSchema.optional(),
  models: z.array(z.string()).optional(),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
} as const;

export const ApiProviderMutationBodySchema = z.object({
  ...ApiProviderMutationSharedFields,
  baseURL: z.url(),
  proxy: ProviderProxySchema,
});

const ApiProviderMutationAuthoringBodySchema = ApiProviderMutationBodySchema.omit({
  baseURL: true,
  proxy: true,
  protocol: true,
}).extend({
  protocol: z.union([ProviderProtocolSchema, ConfigTemplateStringSchema]),
  baseURL: z.union([z.url(), ConfigTemplateStringSchema]),
  proxy: AuthoringProviderProxySchema,
});

const AiSdkProviderMutationSharedFields = {
  kind: z.literal(ProviderKind.AiSdk),
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().optional(),
  packageName: AiSdkPackageNameSchema.optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  parseReasoningContent: z.boolean().optional(),
  models: z.array(z.string()).optional(),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
} as const;

export const AiSdkProviderMutationBodySchema = z.object({
  ...AiSdkProviderMutationSharedFields,
  proxy: ProviderProxySchema,
});

const AiSdkProviderMutationAuthoringBodySchema = AiSdkProviderMutationBodySchema.omit({
  proxy: true,
  packageName: true,
}).extend({
  packageName: z.union([AiSdkPackageNameSchema, ConfigTemplateStringSchema]).optional(),
  proxy: AuthoringProviderProxySchema,
});

export const OAuthProviderMutationBodySchema = z.strictObject({
  kind: z.literal(ProviderKind.OAuth),
  id: z.string().min(1),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  weight: z.number().optional(),
  alias: z.record(z.string().min(1), AliasConfigSchema).optional().describe("Client-facing model aliases."),
});

export const ProviderMutationBodySchema = z
  .discriminatedUnion("kind", [
    ApiProviderMutationBodySchema,
    OAuthProviderMutationBodySchema,
    AiSdkProviderMutationBodySchema,
  ])
  .superRefine(validateAliasTargets)
  .transform((provider) =>
    provider.alias === undefined ? provider : { ...provider, alias: normalizeAliasKeys(provider.alias) },
  );

export const ProviderMutationAuthoringBodySchema = z
  .discriminatedUnion("kind", [
    ApiProviderMutationAuthoringBodySchema,
    OAuthProviderMutationBodySchema,
    AiSdkProviderMutationAuthoringBodySchema,
  ])
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
export type ApiProviderAuthoringInput = z.input<typeof ApiProviderAuthoringSchema>;
export type ApiProviderAuthoring = z.output<typeof ApiProviderAuthoringSchema>;
export type OAuthProviderInput = z.input<typeof OAuthProviderSchema>;
export type OAuthProvider = z.output<typeof OAuthProviderSchema>;
export type OAuthProviderAuthoringInput = z.input<typeof OAuthProviderAuthoringSchema>;
export type OAuthProviderAuthoring = z.output<typeof OAuthProviderAuthoringSchema>;
export type OAuthPluginProviderInput = z.input<typeof OAuthPluginProviderSchema>;
export type OAuthPluginProvider = z.output<typeof OAuthPluginProviderSchema>;
export type AiSdkProviderInput = z.input<typeof AiSdkProviderSchema>;
export type AiSdkProvider = z.output<typeof AiSdkProviderSchema>;
export type AiSdkProviderAuthoringInput = z.input<typeof AiSdkProviderAuthoringSchema>;
export type AiSdkProviderAuthoring = z.output<typeof AiSdkProviderAuthoringSchema>;
export type ApiProviderMutationBodyInput = z.input<typeof ApiProviderMutationBodySchema>;
export type ApiProviderMutationBody = z.output<typeof ApiProviderMutationBodySchema>;
export type AiSdkProviderMutationBodyInput = z.input<typeof AiSdkProviderMutationBodySchema>;
export type AiSdkProviderMutationBody = z.output<typeof AiSdkProviderMutationBodySchema>;
export type OAuthProviderMutationBodyInput = z.input<typeof OAuthProviderMutationBodySchema>;
export type OAuthProviderMutationBody = z.output<typeof OAuthProviderMutationBodySchema>;
export type ProviderMutationBodyInput = z.input<typeof ProviderMutationBodySchema>;
export type ProviderMutationBody = z.output<typeof ProviderMutationBodySchema>;
export type ProviderMutationAuthoringBodyInput = z.input<typeof ProviderMutationAuthoringBodySchema>;
export type ProviderMutationAuthoringBody = z.output<typeof ProviderMutationAuthoringBodySchema>;
export type ProviderInput = z.input<typeof ProviderSchema>;
export type Provider = z.output<typeof ProviderSchema>;
