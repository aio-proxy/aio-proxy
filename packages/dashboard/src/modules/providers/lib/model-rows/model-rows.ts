export interface ModelRow {
  readonly id: string;
  // Rows alias `previousMetadata`'s records by reference; `Readonly` is what stops a consumer
  // from mutating the live config through a row.
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

type MetadataRecord = Readonly<Record<string, Record<string, unknown>>>;

export function toModelRows(models: readonly string[], metadata: MetadataRecord | undefined): ModelRow[] {
  return models.map((id) => ({ id, metadata: metadata?.[id] }));
}

export function applyModelRows(
  rows: readonly ModelRow[],
  previousMetadata: MetadataRecord | undefined,
): { models: string[]; metadata: Record<string, Record<string, unknown>> | undefined } {
  const models = rows.map((row) => row.id);
  const rowIds = new Set(models);
  const merged: Record<string, Record<string, unknown>> = {};
  // Metadata for ids outside models[] (e.g. alias-only targets) must survive.
  for (const [id, value] of Object.entries(previousMetadata ?? {})) {
    if (!rowIds.has(id)) merged[id] = value;
  }
  for (const row of rows) {
    if (row.metadata !== undefined && Object.keys(row.metadata).length > 0) merged[row.id] = row.metadata;
  }
  return { models, metadata: Object.keys(merged).length === 0 ? undefined : merged };
}
