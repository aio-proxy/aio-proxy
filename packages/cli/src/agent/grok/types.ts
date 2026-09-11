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
