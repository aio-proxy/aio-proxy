import { z } from "zod";

import type { InvalidProviderConfig } from "../plugin";

import { PluginPackageNameSchema } from "../plugin";
import {
  AiSdkProviderAuthoringSchema,
  AiSdkProviderSchema,
  ApiProviderAuthoringSchema,
  ApiProviderSchema,
  ConfigTemplateStringSchema,
  HttpProxyUrlSchema,
  OAuthProviderAuthoringSchema,
  OAuthProviderSchema,
  type Provider,
  ProviderKind,
  ProviderSchema,
  validateAliasTargets,
} from "../provider";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const LoopbackHostSchema = z
  .string()
  .refine((host) => LOOPBACK_HOSTS.has(host), "Remote binding requires an authenticated remote-mode design");

const ServerLoggingSchema = z.object({
  enabled: z.boolean().default(false),
  dir: z.string().min(1).optional(),
  retentionDays: z.number().int().min(1).max(365).default(14),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const ServerLoggingAuthoringSchema = ServerLoggingSchema.omit({ dir: true, level: true }).extend({
  dir: z.union([z.string().min(1), ConfigTemplateStringSchema]).optional(),
  level: z.union([z.enum(["debug", "info", "warn", "error"]), ConfigTemplateStringSchema]).default("info"),
});

export const ServerConfigSchema = z.object({
  host: LoopbackHostSchema.default("127.0.0.1").describe("Loopback host for the proxy API server."),
  port: z.number().int().min(1).max(65_535).default(22_078).describe("HTTP port for the proxy API server."),
  password: z.string().min(1).optional().describe("Dashboard password or Argon2id PHC hash."),
  logging: ServerLoggingSchema.prefault({}).optional(),
});

const ServerConfigAuthoringSchema = ServerConfigSchema.omit({ host: true, logging: true }).extend({
  host: z
    .union([LoopbackHostSchema, ConfigTemplateStringSchema])
    .default("127.0.0.1")
    .describe("Loopback host for the proxy API server."),
  logging: ServerLoggingAuthoringSchema.prefault({}).optional(),
});

const ProviderInputValueSchema = z
  .discriminatedUnion("kind", [
    ApiProviderSchema.omit({ id: true }),
    OAuthProviderSchema.omit({ id: true }),
    AiSdkProviderSchema.omit({ id: true }),
  ])
  .superRefine(validateAliasTargets);

const ProviderAuthoringInputValueSchema = z
  .discriminatedUnion("kind", [
    ApiProviderAuthoringSchema.omit({ id: true }),
    OAuthProviderAuthoringSchema.omit({ id: true }),
    AiSdkProviderAuthoringSchema.omit({ id: true }),
  ])
  .superRefine(validateAliasTargets);

const PluginPackageNameAuthoringSchema = z.union([PluginPackageNameSchema, ConfigTemplateStringSchema]);

const PluginEnablementSchema = z
  .union([PluginPackageNameSchema, z.tuple([PluginPackageNameSchema, z.unknown()])])
  .transform((entry) =>
    typeof entry === "string" ? { packageName: entry } : { packageName: entry[0], options: entry[1] },
  );

const PluginEnablementAuthoringSchema = z
  .union([PluginPackageNameAuthoringSchema, z.tuple([PluginPackageNameAuthoringSchema, z.unknown()])])
  .transform((entry) =>
    typeof entry === "string" ? { packageName: entry } : { packageName: entry[0], options: entry[1] },
  );

function refineUniquePlugins(plugins: readonly { readonly packageName: string }[], context: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, plugin] of plugins.entries()) {
    if (seen.has(plugin.packageName)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate plugin ${plugin.packageName}`,
        path: [index],
      });
    }
    seen.add(plugin.packageName);
  }
}

export const PluginsInputSchema = z.array(PluginEnablementSchema).default([]).superRefine(refineUniquePlugins);

const PluginsAuthoringInputSchema = z
  .array(PluginEnablementAuthoringSchema)
  .default([])
  .superRefine(refineUniquePlugins);

const CONFIG_PROXY_DESCRIPTION = "Default HTTP(S) proxy URL inherited by providers that omit their own proxy.";

export const ConfigAuthoringSchema = z.object({
  server: ServerConfigAuthoringSchema.prefault({}).describe("Local server settings."),
  plugins: PluginsAuthoringInputSchema,
  proxy: z.union([HttpProxyUrlSchema, ConfigTemplateStringSchema]).optional().describe(CONFIG_PROXY_DESCRIPTION),
  providers: z.record(z.string().min(1), ProviderAuthoringInputValueSchema),
});

const ConfigEnvelopeSchema = z.object({
  server: ServerConfigSchema.prefault({}).describe("Local server settings."),
  plugins: PluginsInputSchema,
  proxy: HttpProxyUrlSchema.optional().describe(CONFIG_PROXY_DESCRIPTION),
  providers: z.record(z.string().min(1), z.unknown()),
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLegacyOAuthEntry(value: unknown): boolean {
  return isRecord(value) && value["kind"] === ProviderKind.OAuth && Object.hasOwn(value, "vendor");
}

function inferProviderKind(value: unknown): ProviderKind | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value["kind"];
  return Object.values(ProviderKind).includes(kind as ProviderKind) ? (kind as ProviderKind) : undefined;
}

function safeIssuePath(path: readonly PropertyKey[]): readonly (string | number)[] {
  return path.filter(
    (segment): segment is string | number => typeof segment === "string" || typeof segment === "number",
  );
}

export const ConfigSchema = ConfigEnvelopeSchema.transform((input) => {
  const providers: Provider[] = [];
  const invalidProviders: InvalidProviderConfig[] = [];
  for (const [id, raw] of Object.entries(input.providers)) {
    if (isLegacyOAuthEntry(raw)) {
      invalidProviders.push({
        id,
        kind: ProviderKind.OAuth,
        code: "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
        issuePaths: [["vendor"]],
      });
      continue;
    }
    const result = ProviderInputValueSchema.safeParse(raw);
    if (!result.success) {
      const kind = inferProviderKind(raw);
      invalidProviders.push({
        id,
        ...(kind === undefined ? {} : { kind }),
        code: "PROVIDER_CONFIG_INVALID",
        issuePaths: result.error.issues.map((issue) => safeIssuePath(issue.path)),
      });
      continue;
    }
    providers.push(ProviderSchema.parse({ ...result.data, id }));
  }
  providers.sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0));
  return { server: input.server, plugins: input.plugins, proxy: input.proxy, providers, invalidProviders };
});

export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type ConfigInput = z.input<typeof ConfigAuthoringSchema>;
export type Config = z.output<typeof ConfigSchema>;
