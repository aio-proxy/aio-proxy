import { z } from "zod";
import { ProviderSchema } from "./provider";

export const ServerConfigSchema = z.object({
  host: z.string().min(1).default("127.0.0.1").describe("HTTP host for the proxy API server."),
  port: z.number().int().min(1).max(65_535).default(22_078).describe("HTTP port for the proxy API server."),
});

export const ConfigSchema = z.object({
  server: ServerConfigSchema.prefault({}).describe("Local server settings."),
  providers: z.array(ProviderSchema).describe("Provider backends and model aliases exposed by aio-proxy."),
});

export type ServerConfigInput = z.input<typeof ServerConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;
