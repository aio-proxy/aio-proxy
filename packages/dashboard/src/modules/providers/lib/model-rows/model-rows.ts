export interface ModelRow {
  readonly id: string;
  // Rows alias their records by reference; `Readonly` is what stops a consumer from writing through
  // a row into the form value.
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
}

type MetadataRecord = Readonly<Record<string, Record<string, unknown>>>;

export function toModelRows(models: readonly string[], metadata: MetadataRecord | undefined): ModelRow[] {
  return models.map((id) => ({ id, metadata: metadata?.[id] }));
}

export function applyModelRows(
  rows: readonly ModelRow[],
  previousMetadata: MetadataRecord | undefined,
): { models: string[]; metadata: Record<string, Readonly<Record<string, unknown>>> | undefined } {
  const models = rows.map((row) => row.id);
  const rowIds = new Set(models);
  // Best-effort only: the records are aliased, and the form value plus the mutation DTOs re-widen
  // the same references one hop later. `readonly` is ignored in assignability, so this still flows
  // into `metadata` on the mutation bodies with no cast.
  const merged: Record<string, Readonly<Record<string, unknown>>> = {};
  // Metadata for ids outside models[] (e.g. alias-only targets) must survive.
  for (const [id, value] of Object.entries(previousMetadata ?? {})) {
    if (!rowIds.has(id)) merged[id] = value;
  }
  for (const row of rows) {
    if (row.metadata !== undefined && Object.keys(row.metadata).length > 0) merged[row.id] = row.metadata;
  }
  return { models, metadata: Object.keys(merged).length === 0 ? undefined : merged };
}
