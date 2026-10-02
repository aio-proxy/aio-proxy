import type { Database } from 'bun:sqlite';

export type ProviderModelCatalogFailureCode = 'CATALOG_UNAVAILABLE' | 'CATALOG_UNSUPPORTED';

export type StoredProviderModels = {
  readonly sourceDigest: string;
  readonly models: readonly string[] | null;
  readonly refreshedAt: number | null;
  readonly failure: { readonly code: ProviderModelCatalogFailureCode; readonly at: number } | null;
};

export type ProviderModelCatalogRepository = {
  readonly read: (providerId: string) => StoredProviderModels | null;
  /** Replaces models, sets refreshedAt, clears failure. */
  readonly writeSuccess: (
    providerId: string,
    sourceDigest: string,
    models: readonly string[],
    refreshedAt: number,
  ) => void;
  /** Records the failure. When sourceDigest differs from the stored row, models/refreshedAt are reset to null. */
  readonly writeFailure: (
    providerId: string,
    sourceDigest: string,
    code: ProviderModelCatalogFailureCode,
    at: number,
  ) => void;
};

type CatalogRow = {
  source_digest: string;
  models_json: string | null;
  refreshed_at: number | null;
  failure_code: ProviderModelCatalogFailureCode | null;
  failed_at: number | null;
};

export function createProviderModelCatalogRepository(sqlite: Database): ProviderModelCatalogRepository {
  const selectCatalog = sqlite.query<CatalogRow, [string]>(
    'SELECT source_digest, models_json, refreshed_at, failure_code, failed_at FROM provider_model_catalog WHERE provider_id = ?',
  );
  const upsertSuccess = sqlite.query(
    `INSERT INTO provider_model_catalog (provider_id, source_digest, models_json, refreshed_at, failure_code, failed_at)
     VALUES (?, ?, ?, ?, NULL, NULL)
     ON CONFLICT (provider_id) DO UPDATE SET source_digest = excluded.source_digest,
       models_json = excluded.models_json, refreshed_at = excluded.refreshed_at,
       failure_code = NULL, failed_at = NULL`,
  );
  const upsertFailure = sqlite.query(
    `INSERT INTO provider_model_catalog (provider_id, source_digest, failure_code, failed_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (provider_id) DO UPDATE SET source_digest = excluded.source_digest,
       models_json = CASE WHEN provider_model_catalog.source_digest = excluded.source_digest
         THEN provider_model_catalog.models_json ELSE NULL END,
       refreshed_at = CASE WHEN provider_model_catalog.source_digest = excluded.source_digest
         THEN provider_model_catalog.refreshed_at ELSE NULL END,
       failure_code = excluded.failure_code, failed_at = excluded.failed_at`,
  );

  return {
    read(providerId) {
      const row = selectCatalog.get(providerId);
      return row === null
        ? null
        : {
            sourceDigest: row.source_digest,
            models: row.models_json === null ? null : (JSON.parse(row.models_json) as string[]),
            refreshedAt: row.refreshed_at,
            failure:
              row.failure_code === null || row.failed_at === null
                ? null
                : { code: row.failure_code, at: row.failed_at },
          };
    },
    writeSuccess(providerId, sourceDigest, models, refreshedAt) {
      upsertSuccess.run(providerId, sourceDigest, JSON.stringify(models), refreshedAt);
    },
    writeFailure(providerId, sourceDigest, code, at) {
      upsertFailure.run(providerId, sourceDigest, code, at);
    },
  };
}
