import type { Database } from "bun:sqlite";
import type { ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { Diagnostic } from "@aio-proxy/types";
import { type CatalogRow, type DiagnosticRow, decodeJson, encodeJson, type PluginSecretRow } from "./rows";
import type { AccountWrite, PluginRepository, StoredCatalog } from "./types";

export function createPluginStateRows(sqlite: Database) {
  const selectCatalog = sqlite.query<CatalogRow, [string]>(
    "SELECT catalog_json, refreshed_at FROM oauth_catalog WHERE provider_id = ?",
  );
  const selectDiagnostics = sqlite.query<DiagnosticRow, [string]>(
    "SELECT diagnostic_json FROM oauth_account_diagnostic WHERE provider_id = ? ORDER BY code",
  );
  function readCatalog(providerId: string): StoredCatalog | null {
    const row = selectCatalog.get(providerId);
    return row === null ? null : { catalog: decodeJson<ModelCatalog>(row.catalog_json), refreshedAt: row.refreshed_at };
  }
  function readDiagnostics(providerId: string): readonly Diagnostic[] {
    return selectDiagnostics.all(providerId).map(({ diagnostic_json }) => decodeJson<Diagnostic>(diagnostic_json));
  }
  function replaceCatalog(providerId: string, value: StoredCatalog): void {
    sqlite
      .query(
        `INSERT INTO oauth_catalog (provider_id, catalog_json, refreshed_at) VALUES (?, ?, ?)
         ON CONFLICT (provider_id) DO UPDATE SET catalog_json = excluded.catalog_json,
           refreshed_at = excluded.refreshed_at`,
      )
      .run(providerId, encodeJson(value.catalog), value.refreshedAt);
  }
  function upsertDiagnostic(providerId: string, value: Diagnostic): boolean {
    return (
      sqlite
        .query(
          `INSERT INTO oauth_account_diagnostic (provider_id, code, diagnostic_json)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM oauth_account WHERE provider_id = ?)
           ON CONFLICT (provider_id, code) DO UPDATE SET diagnostic_json = excluded.diagnostic_json
           WHERE oauth_account_diagnostic.diagnostic_json <> excluded.diagnostic_json`,
        )
        .run(providerId, value.code, encodeJson(value), providerId).changes > 0
    );
  }
  function applyCatalog(providerId: string, value: AccountWrite["catalog"]): void {
    if (value.kind === "replace") {
      replaceCatalog(providerId, value.value);
      sqlite
        .query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = 'CATALOG_UNAVAILABLE'")
        .run(providerId);
      return;
    }
    if (value.kind === "missing") sqlite.query("DELETE FROM oauth_catalog WHERE provider_id = ?").run(providerId);
    upsertDiagnostic(providerId, value.diagnostic);
  }
  return { readCatalog, readDiagnostics, replaceCatalog, upsertDiagnostic, applyCatalog };
}

export function createPluginStateRepository(
  sqlite: Database,
): Pick<
  PluginRepository,
  | "readPluginSecret"
  | "writePluginSecret"
  | "deletePluginSecret"
  | "readCatalog"
  | "writeCatalog"
  | "readDiagnostics"
  | "writeDiagnostic"
  | "clearDiagnostic"
  | "tryAcquireRefreshLease"
  | "renewRefreshLease"
  | "releaseRefreshLease"
> {
  const rows = createPluginStateRows(sqlite);
  return {
    readPluginSecret(plugin) {
      const row = sqlite
        .query<PluginSecretRow, [string]>("SELECT value_json, revision FROM plugin_secret WHERE plugin = ?")
        .get(plugin);
      return row === null ? null : { value: decodeJson(row.value_json), revision: row.revision };
    },
    writePluginSecret(plugin, expectedRevision, value) {
      const encoded = encodeJson(value);
      return sqlite
        .transaction(() => {
          const updatedAt = Date.now();
          if (expectedRevision === null) {
            sqlite
              .query("INSERT INTO plugin_secret (plugin, value_json, revision, updated_at) VALUES (?, ?, 1, ?)")
              .run(plugin, encoded, updatedAt);
            return { value, revision: 1 };
          }
          const result = sqlite
            .query(
              "UPDATE plugin_secret SET value_json = ?, revision = revision + 1, updated_at = ? WHERE plugin = ? AND revision = ?",
            )
            .run(encoded, updatedAt, plugin, expectedRevision);
          if (result.changes === 0) throw new Error("Plugin secret revision mismatch");
          return { value, revision: expectedRevision + 1 };
        })
        .immediate();
    },
    deletePluginSecret(plugin, expectedRevision) {
      return sqlite
        .transaction(
          () =>
            sqlite.query("DELETE FROM plugin_secret WHERE plugin = ? AND revision = ?").run(plugin, expectedRevision)
              .changes > 0,
        )
        .immediate();
    },
    readCatalog: rows.readCatalog,
    writeCatalog(providerId, value, refreshedAt) {
      sqlite
        .transaction(() => {
          rows.replaceCatalog(providerId, { catalog: value, refreshedAt });
          sqlite
            .query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = 'CATALOG_UNAVAILABLE'")
            .run(providerId);
        })
        .immediate();
    },
    readDiagnostics: rows.readDiagnostics,
    writeDiagnostic: rows.upsertDiagnostic,
    clearDiagnostic(providerId, code) {
      return (
        sqlite.query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = ?").run(providerId, code)
          .changes > 0
      );
    },
    tryAcquireRefreshLease(providerId, owner, now, expiresAt) {
      return sqlite
        .transaction(
          () =>
            sqlite
              .query(
                `INSERT INTO oauth_refresh_lease (provider_id, owner, expires_at) VALUES (?, ?, ?)
                 ON CONFLICT (provider_id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
                 WHERE oauth_refresh_lease.owner = excluded.owner OR oauth_refresh_lease.expires_at <= ?`,
              )
              .run(providerId, owner, expiresAt, now).changes > 0,
        )
        .immediate();
    },
    renewRefreshLease(providerId, owner, expiresAt) {
      return (
        sqlite
          .query("UPDATE oauth_refresh_lease SET expires_at = ? WHERE provider_id = ? AND owner = ?")
          .run(expiresAt, providerId, owner).changes > 0
      );
    },
    releaseRefreshLease(providerId, owner) {
      sqlite.query("DELETE FROM oauth_refresh_lease WHERE provider_id = ? AND owner = ?").run(providerId, owner);
    },
  };
}
