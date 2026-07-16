import { providerOptionsSchema } from "@aio-proxy/provider-schemas";

export type LocalProviderOptionsSchema =
  | {
      readonly resolution: "ready";
      readonly schema: Readonly<Record<string, unknown>>;
      readonly warnings: readonly { readonly code: string; readonly path: string }[];
    }
  | {
      readonly resolution: "unavailable";
      readonly schema: undefined;
      readonly warnings: readonly [];
    };

export const resolveLocalProviderOptionsSchema = (packageName: string): LocalProviderOptionsSchema => {
  const entry = providerOptionsSchema(packageName);
  if (entry === undefined || entry.schema === null) {
    return { resolution: "unavailable", schema: undefined, warnings: [] };
  }
  return {
    resolution: "ready",
    schema: entry.schema,
    warnings: entry.warnings,
  };
};
