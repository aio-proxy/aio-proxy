import { z } from "zod";
import { PluginPackageNameSchema } from "./plugin";
import {
  AiSdkProviderSchema,
  ApiProviderSchema,
  OAuthProviderSchema,
  ProviderSchema,
  validateAliasTargets,
} from "./provider";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const ServerConfigSchema = z.object({
  host: z
    .string()
    .refine((host) => LOOPBACK_HOSTS.has(host), "Remote binding requires an authenticated remote-mode design")
    .default("127.0.0.1")
    .describe("Loopback host for the proxy API server."),
  port: z.number().int().min(1).max(65_535).default(22_078).describe("HTTP port for the proxy API server."),
});

const ProviderInputValueSchema = z
  .discriminatedUnion("kind", [
    ApiProviderSchema.omit({ id: true }),
    OAuthProviderSchema.omit({ id: true }),
    AiSdkProviderSchema.omit({ id: true }),
  ])
  .superRefine(validateAliasTargets);

const ProvidersInputSchema = z
  .record(z.string().min(1), ProviderInputValueSchema)
  .transform((providers): z.output<typeof ProviderSchema>[] =>
    Object.entries(providers)
      .map(([id, provider]) => ProviderSchema.parse({ ...provider, id }))
      .sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0)),
  );

const PluginEnablementSchema = z
  .union([PluginPackageNameSchema, z.tuple([PluginPackageNameSchema, z.unknown()])])
  .transform((entry) =>
    typeof entry === "string" ? { packageName: entry } : { packageName: entry[0], options: entry[1] },
  );

const PluginsInputSchema = z
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

export const ConfigSchema = z.object({
  plugins: PluginsInputSchema,
  server: ServerConfigSchema.prefault({}).describe("Local server settings."),
  providers: ProvidersInputSchema.describe("Provider backends keyed by stable provider id."),
});

export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;
