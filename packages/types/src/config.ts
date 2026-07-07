import { z } from "zod";
import {
  AiSdkProviderSchema,
  ApiProviderSchema,
  OAuthProviderSchema,
  ProviderSchema,
  validateAliasTargets,
} from "./provider";

export const ServerConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1").describe("HTTP host for the proxy API server."),
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

export const ConfigSchema = z.object({
  server: ServerConfigSchema.prefault({}).describe("Local server settings."),
  providers: ProvidersInputSchema.describe("Provider backends keyed by stable provider id."),
});

export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;
