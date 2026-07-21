import { type Config, ConfigSchema } from "@aio-proxy/types";

import { resolveConfigTemplates } from "./resolve-config-templates";

export function parseRuntimeConfig(
  value: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  return ConfigSchema.parse(resolveConfigTemplates(value, env));
}
