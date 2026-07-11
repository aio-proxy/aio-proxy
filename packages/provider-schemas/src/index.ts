import { PROVIDER_OPTIONS_SCHEMAS } from "./generated";

export const providerOptionsSchema = (packageName: string) => {
  const entry = PROVIDER_OPTIONS_SCHEMAS[packageName];
  return entry?.schema === null ? undefined : entry;
};

export const hasProviderOptionsSchema = (packageName: string) => providerOptionsSchema(packageName) !== undefined;

export type { ProviderSchemaAllowlistEntry } from "./allowlist";
export { PROVIDER_SCHEMA_ALLOWLIST } from "./allowlist";
export type {
  JsonSchema,
  ProviderOptionsSchemaEntry,
  ProviderOptionsSchemaWarning,
} from "./types";
