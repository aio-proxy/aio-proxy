export type JsonSchema = Readonly<Record<string, unknown>>;

export type ProviderOptionsSchemaWarning = {
  readonly code: "unsupported_optional" | "unresolved_optional";
  readonly path: string;
};

export type ProviderOptionsSchemaEntry = {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly factoryName: string;
  readonly schema: JsonSchema | null;
  readonly warnings: readonly ProviderOptionsSchemaWarning[];
};
