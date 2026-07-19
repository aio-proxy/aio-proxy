import { z } from "zod";

import type { InvalidProviderConfig } from "./plugin";

import { PluginPackageNameSchema } from "./plugin";
import {
  AiSdkProviderSchema,
  ApiProviderSchema,
  OAuthProviderSchema,
  type Provider,
  ProviderKind,
  ProviderSchema,
  validateAliasTargets,
} from "./provider";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const ServerLoggingSchema = z.object({
  enabled: z.boolean().default(false),
  dir: z.string().min(1).optional(),
  retentionDays: z.number().int().min(1).max(365).default(14),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const ServerConfigSchema = z.object({
  host: z
    .string()
    .refine((host) => LOOPBACK_HOSTS.has(host), "Remote binding requires an authenticated remote-mode design")
    .default("127.0.0.1")
    .describe("Loopback host for the proxy API server."),
  port: z.number().int().min(1).max(65_535).default(22_078).describe("HTTP port for the proxy API server."),
  logging: ServerLoggingSchema.prefault({}).optional(),
});

const ProviderInputValueSchema = z
  .discriminatedUnion("kind", [
    ApiProviderSchema.omit({ id: true }),
    OAuthProviderSchema.omit({ id: true }),
    AiSdkProviderSchema.omit({ id: true }),
  ])
  .superRefine(validateAliasTargets);

const PluginEnablementSchema = z
  .union([PluginPackageNameSchema, z.tuple([PluginPackageNameSchema, z.unknown()])])
  .transform((entry) =>
    typeof entry === "string" ? { packageName: entry } : { packageName: entry[0], options: entry[1] },
  );

export const PluginsInputSchema = z
  .array(PluginEnablementSchema)
  .default([])
  .superRefine((plugins, context) => {
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
  });

export const ConfigAuthoringSchema = z.object({
  server: ServerConfigSchema.prefault({}).describe("Local server settings."),
  plugins: PluginsInputSchema,
  providers: z.record(z.string().min(1), ProviderInputValueSchema),
});

const ConfigEnvelopeSchema = z.object({
  server: ServerConfigSchema.prefault({}).describe("Local server settings."),
  plugins: PluginsInputSchema,
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
  return { server: input.server, plugins: input.plugins, providers, invalidProviders };
});

export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type ConfigInput = z.input<typeof ConfigAuthoringSchema>;
export type Config = z.output<typeof ConfigSchema>;
