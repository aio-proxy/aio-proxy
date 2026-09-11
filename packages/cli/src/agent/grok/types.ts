export type GrokPath = readonly string[];
export type LeafValue =
  | { readonly present: false }
  | { readonly present: true; readonly value: string; readonly raw: string };
export type OwnedLeaf = {
  readonly path: GrokPath;
  readonly original: LeafValue;
  readonly written: LeafValue;
};
export type FieldChange = { readonly path: GrokPath; readonly before: LeafValue; readonly after: LeafValue };
export type TomlEdit = {
  readonly text: string;
  readonly leaves: readonly OwnedLeaf[];
  readonly createdTables: readonly GrokPath[];
  readonly changes: readonly FieldChange[];
  readonly skipped: readonly string[];
};
export type GrokDeadline = { readonly deadline: number; readonly signal: AbortSignal };
export type GrokPolicySource = { readonly path: string; readonly text: string; readonly kind: 'toml' | 'json' };
export type GrokVisiblePolicy = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sources: readonly GrokPolicySource[];
};
