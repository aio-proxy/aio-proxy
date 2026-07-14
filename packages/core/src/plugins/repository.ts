import type { Database } from "bun:sqlite";
import type { ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { Diagnostic, DiagnosticCode } from "@aio-proxy/types";

export type PluginSecretSnapshot = {
  readonly value: unknown;
  readonly revision: number;
};

export type StoredAccount = {
  readonly providerId: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly options: unknown;
  readonly secrets: unknown;
  readonly credential: unknown;
  readonly revision: number;
  readonly runtimeRevision: number;
  readonly label?: string;
  readonly expiresAt?: number;
  readonly updatedAt: number;
};

export type StoredAccountSummary = Omit<StoredAccount, "options" | "secrets" | "credential">;

export type StoredCatalog = {
  readonly catalog: ModelCatalog;
  readonly refreshedAt: number;
};

export type PendingAccountOperation = {
  readonly operationId: string;
  readonly providerId: string;
  readonly kind: "create" | "update" | "delete";
  readonly targetDigest: string;
  readonly appliedRevision: number;
  readonly previousRevision?: number;
  readonly createdAt: number;
};

export type AccountWrite = {
  readonly providerId: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly options: unknown;
  readonly secrets: unknown;
  readonly credential: unknown;
  readonly label?: string;
  readonly expiresAt?: number;
  readonly catalog:
    | { readonly kind: "replace"; readonly value: StoredCatalog }
    | { readonly kind: "preserve"; readonly diagnostic: Diagnostic }
    | { readonly kind: "missing"; readonly diagnostic: Diagnostic };
};

export type StageAccountOperationInput =
  | { readonly kind: "create"; readonly targetDigest: string; readonly account: AccountWrite }
  | {
      readonly kind: "update";
      readonly targetDigest: string;
      readonly expectedRuntimeRevision: number;
      readonly account: AccountWrite;
    }
  | {
      readonly kind: "delete";
      readonly targetDigest: "absent";
      readonly providerId: string;
      readonly expectedRuntimeRevision: number;
    };

export type PluginRepository = {
  readonly readPluginSecret: (plugin: string) => PluginSecretSnapshot | null;
  readonly writePluginSecret: (plugin: string, expectedRevision: number | null, value: unknown) => PluginSecretSnapshot;
  readonly deletePluginSecret: (plugin: string, expectedRevision: number) => boolean;
  readonly readAccount: (providerId: string) => StoredAccount | null;
  readonly findAccountByFingerprint: (plugin: string, capability: string, fingerprint: string) => StoredAccount | null;
  readonly listAccounts: () => readonly StoredAccountSummary[];
  readonly readCatalog: (providerId: string) => StoredCatalog | null;
  readonly writeCatalog: (providerId: string, catalog: ModelCatalog, refreshedAt: number) => void;
  readonly readDiagnostics: (providerId: string) => readonly Diagnostic[];
  readonly writeDiagnostic: (providerId: string, diagnostic: Diagnostic) => boolean;
  readonly clearDiagnostic: (providerId: string, code: DiagnosticCode) => boolean;
  readonly deleteAccount: (providerId: string) => void;
  readonly stageAccountOperation: (input: StageAccountOperationInput) => PendingAccountOperation;
  readonly completeAccountOperation: (operationId: string) => void;
  readonly compensateAccountOperation: (operationId: string) => "compensated" | "superseded";
  readonly finalizeDeleteOperation: (operationId: string) => "deleted" | "superseded";
  readonly listPendingAccountOperations: () => readonly PendingAccountOperation[];
  readonly tryAcquireRefreshLease: (providerId: string, owner: string, now: number, expiresAt: number) => boolean;
  readonly renewRefreshLease: (providerId: string, owner: string, expiresAt: number) => boolean;
  readonly releaseRefreshLease: (providerId: string, owner: string) => void;
  readonly compareAndSwapCredential: (
    providerId: string,
    expectedRevision: number,
    credential: unknown,
    metadata?: { readonly label?: string; readonly expiresAt?: number },
  ) => StoredAccount | null;
};

type AccountRow = {
  readonly provider_id: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly options_json: string;
  readonly secret_json: string;
  readonly credential_json: string;
  readonly revision: number;
  readonly runtime_revision: number;
  readonly label: string | null;
  readonly expires_at: number | null;
  readonly updated_at: number;
};

type AccountSummaryRow = Omit<AccountRow, "options_json" | "secret_json" | "credential_json">;

type CatalogRow = { readonly catalog_json: string; readonly refreshed_at: number };
type DiagnosticRow = { readonly diagnostic_json: string };
type PluginSecretRow = { readonly value_json: string; readonly revision: number };
type PendingRow = {
  readonly operation_id: string;
  readonly provider_id: string;
  readonly kind: "create" | "update" | "delete";
  readonly target_digest: string;
  readonly applied_revision: number;
  readonly previous_revision: number | null;
  readonly rollback_json: string | null;
  readonly created_at: number;
};

type RollbackSnapshot = StoredAccount & {
  readonly catalog: StoredCatalog | null;
  readonly diagnostics: readonly Diagnostic[];
};

type ChildSnapshot = Pick<RollbackSnapshot, "catalog" | "diagnostics">;

type AccountOperationRollback = {
  readonly previous: RollbackSnapshot;
  readonly applied: ChildSnapshot;
};

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Plugin vault values must be JSON serializable");
  return encoded;
}

function decodeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function storedAccount(row: AccountRow): StoredAccount {
  return {
    providerId: row.provider_id,
    plugin: row.plugin,
    capability: row.capability,
    fingerprint: row.fingerprint,
    options: decodeJson(row.options_json),
    secrets: decodeJson(row.secret_json),
    credential: decodeJson(row.credential_json),
    revision: row.revision,
    runtimeRevision: row.runtime_revision,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    updatedAt: row.updated_at,
  };
}

function storedAccountSummary(row: AccountSummaryRow): StoredAccountSummary {
  return {
    providerId: row.provider_id,
    plugin: row.plugin,
    capability: row.capability,
    fingerprint: row.fingerprint,
    revision: row.revision,
    runtimeRevision: row.runtime_revision,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    updatedAt: row.updated_at,
  };
}

function pendingOperation(row: PendingRow): PendingAccountOperation {
  return {
    operationId: row.operation_id,
    providerId: row.provider_id,
    kind: row.kind,
    targetDigest: row.target_digest,
    appliedRevision: row.applied_revision,
    ...(row.previous_revision === null ? {} : { previousRevision: row.previous_revision }),
    createdAt: row.created_at,
  };
}

const ACCOUNT_COLUMNS = `provider_id, plugin, capability, fingerprint, options_json, secret_json,
  credential_json, revision, runtime_revision, label, expires_at, updated_at`;
const ACCOUNT_SUMMARY_COLUMNS = `provider_id, plugin, capability, fingerprint, revision,
  runtime_revision, label, expires_at, updated_at`;

export function createPluginRepository(sqlite: Database): PluginRepository {
  const selectAccount = sqlite.query<AccountRow, [string]>(
    `SELECT ${ACCOUNT_COLUMNS} FROM oauth_account WHERE provider_id = ?`,
  );
  const selectCatalog = sqlite.query<CatalogRow, [string]>(
    "SELECT catalog_json, refreshed_at FROM oauth_catalog WHERE provider_id = ?",
  );
  const selectDiagnostics = sqlite.query<DiagnosticRow, [string]>(
    "SELECT diagnostic_json FROM oauth_account_diagnostic WHERE provider_id = ? ORDER BY code",
  );
  const selectPending = sqlite.query<PendingRow, [string]>(
    `SELECT operation_id, provider_id, kind, target_digest, applied_revision, previous_revision,
       rollback_json, created_at
     FROM oauth_pending_operation WHERE operation_id = ?`,
  );

  function readStoredCatalog(providerId: string): StoredCatalog | null {
    const row = selectCatalog.get(providerId);
    return row === null ? null : { catalog: decodeJson<ModelCatalog>(row.catalog_json), refreshedAt: row.refreshed_at };
  }

  function readStoredDiagnostics(providerId: string): readonly Diagnostic[] {
    return selectDiagnostics.all(providerId).map(({ diagnostic_json }) => decodeJson<Diagnostic>(diagnostic_json));
  }

  function snapshot(row: AccountRow): RollbackSnapshot {
    return {
      ...storedAccount(row),
      catalog: readStoredCatalog(row.provider_id),
      diagnostics: readStoredDiagnostics(row.provider_id),
    };
  }

  function childSnapshot(providerId: string): ChildSnapshot {
    return {
      catalog: readStoredCatalog(providerId),
      diagnostics: readStoredDiagnostics(providerId),
    };
  }

  function childSnapshotsEqual(left: ChildSnapshot, right: ChildSnapshot): boolean {
    return encodeJson(left) === encodeJson(right);
  }

  function assertNoPendingOperation(providerId: string): void {
    const pending = sqlite
      .query<{ readonly operation_id: string }, [string]>(
        "SELECT operation_id FROM oauth_pending_operation WHERE provider_id = ? LIMIT 1",
      )
      .get(providerId);
    if (pending !== null) throw new Error("Account already has a pending operation");
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
    const result = sqlite
      .query(
        `INSERT INTO oauth_account_diagnostic (provider_id, code, diagnostic_json) VALUES (?, ?, ?)
         ON CONFLICT (provider_id, code) DO NOTHING`,
      )
      .run(providerId, value.code, encodeJson(value));
    return result.changes > 0;
  }

  function applyCatalog(providerId: string, value: AccountWrite["catalog"]): void {
    if (value.kind === "replace") {
      replaceCatalog(providerId, value.value);
      sqlite
        .query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = 'CATALOG_UNAVAILABLE'")
        .run(providerId);
      return;
    }
    if (value.kind === "missing") {
      sqlite.query("DELETE FROM oauth_catalog WHERE provider_id = ?").run(providerId);
    }
    upsertDiagnostic(providerId, value.diagnostic);
  }

  function insertAccount(value: AccountWrite, revision: number, runtimeRevision: number, updatedAt: number): void {
    sqlite
      .query(
        `INSERT INTO oauth_account (
           provider_id, plugin, capability, fingerprint, options_json, secret_json, credential_json,
           revision, runtime_revision, label, expires_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.providerId,
        value.plugin,
        value.capability,
        value.fingerprint,
        encodeJson(value.options),
        encodeJson(value.secrets),
        encodeJson(value.credential),
        revision,
        runtimeRevision,
        value.label ?? null,
        value.expiresAt ?? null,
        updatedAt,
      );
  }

  function updateAccount(value: AccountWrite, revision: number, runtimeRevision: number, updatedAt: number): void {
    sqlite
      .query(
        `UPDATE oauth_account SET plugin = ?, capability = ?, fingerprint = ?, options_json = ?,
           secret_json = ?, credential_json = ?, revision = ?, runtime_revision = ?, label = ?, expires_at = ?,
           updated_at = ? WHERE provider_id = ?`,
      )
      .run(
        value.plugin,
        value.capability,
        value.fingerprint,
        encodeJson(value.options),
        encodeJson(value.secrets),
        encodeJson(value.credential),
        revision,
        runtimeRevision,
        value.label ?? null,
        value.expiresAt ?? null,
        updatedAt,
        value.providerId,
      );
  }

  function restoreSnapshot(value: RollbackSnapshot): void {
    sqlite
      .query(
        `UPDATE oauth_account SET plugin = ?, capability = ?, fingerprint = ?, options_json = ?,
           secret_json = ?, credential_json = ?, revision = ?, runtime_revision = ?, label = ?, expires_at = ?,
           updated_at = ? WHERE provider_id = ?`,
      )
      .run(
        value.plugin,
        value.capability,
        value.fingerprint,
        encodeJson(value.options),
        encodeJson(value.secrets),
        encodeJson(value.credential),
        value.revision,
        value.runtimeRevision,
        value.label ?? null,
        value.expiresAt ?? null,
        value.updatedAt,
        value.providerId,
      );
    sqlite.query("DELETE FROM oauth_catalog WHERE provider_id = ?").run(value.providerId);
    if (value.catalog !== null) replaceCatalog(value.providerId, value.catalog);
    sqlite.query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ?").run(value.providerId);
    for (const item of value.diagnostics) upsertDiagnostic(value.providerId, item);
  }

  function insertPending(
    providerId: string,
    kind: PendingAccountOperation["kind"],
    targetDigest: string,
    appliedRevision: number,
    previousRevision: number | undefined,
    rollback: AccountOperationRollback | undefined,
  ): PendingAccountOperation {
    const value: PendingAccountOperation = {
      operationId: crypto.randomUUID(),
      providerId,
      kind,
      targetDigest,
      appliedRevision,
      ...(previousRevision === undefined ? {} : { previousRevision }),
      createdAt: Date.now(),
    };
    sqlite
      .query(
        `INSERT INTO oauth_pending_operation (
           operation_id, provider_id, kind, target_digest, applied_revision, previous_revision, rollback_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.operationId,
        providerId,
        kind,
        targetDigest,
        appliedRevision,
        previousRevision ?? null,
        rollback === undefined ? null : encodeJson(rollback),
        value.createdAt,
      );
    return value;
  }

  const repository: PluginRepository = {
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
    readAccount(providerId) {
      const row = selectAccount.get(providerId);
      return row === null ? null : storedAccount(row);
    },
    findAccountByFingerprint(plugin, capability, fingerprint) {
      const row = sqlite
        .query<AccountRow, [string, string, string]>(
          `SELECT ${ACCOUNT_COLUMNS} FROM oauth_account
           WHERE plugin = ? AND capability = ? AND fingerprint = ?`,
        )
        .get(plugin, capability, fingerprint);
      return row === null ? null : storedAccount(row);
    },
    listAccounts() {
      return sqlite
        .query<AccountSummaryRow, []>(`SELECT ${ACCOUNT_SUMMARY_COLUMNS} FROM oauth_account ORDER BY provider_id`)
        .all()
        .map(storedAccountSummary);
    },
    readCatalog: readStoredCatalog,
    writeCatalog(providerId, value, refreshedAt) {
      sqlite
        .transaction(() => {
          replaceCatalog(providerId, { catalog: value, refreshedAt });
          sqlite
            .query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = 'CATALOG_UNAVAILABLE'")
            .run(providerId);
        })
        .immediate();
    },
    readDiagnostics: readStoredDiagnostics,
    writeDiagnostic: upsertDiagnostic,
    clearDiagnostic(providerId, code) {
      return (
        sqlite.query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = ?").run(providerId, code)
          .changes > 0
      );
    },
    deleteAccount(providerId) {
      sqlite.query("DELETE FROM oauth_account WHERE provider_id = ?").run(providerId);
    },
    stageAccountOperation(input) {
      return sqlite
        .transaction(() => {
          if (input.kind === "create") {
            assertNoPendingOperation(input.account.providerId);
            insertAccount(input.account, 1, 1, Date.now());
            applyCatalog(input.account.providerId, input.account.catalog);
            return insertPending(input.account.providerId, "create", input.targetDigest, 1, undefined, undefined);
          }

          const providerId = input.kind === "update" ? input.account.providerId : input.providerId;
          assertNoPendingOperation(providerId);
          const current = selectAccount.get(providerId);
          if (current === null || current.runtime_revision !== input.expectedRuntimeRevision) {
            throw new Error("Account runtime revision mismatch");
          }
          const rollback = snapshot(current);

          if (input.kind === "delete") {
            return insertPending(providerId, "delete", input.targetDigest, current.runtime_revision, current.revision, {
              previous: rollback,
              applied: childSnapshot(providerId),
            });
          }

          const revision = current.revision + 1;
          const runtimeRevision = current.runtime_revision + 1;
          updateAccount(input.account, revision, runtimeRevision, Date.now());
          applyCatalog(providerId, input.account.catalog);
          return insertPending(providerId, "update", input.targetDigest, revision, current.revision, {
            previous: rollback,
            applied: childSnapshot(providerId),
          });
        })
        .immediate();
    },
    completeAccountOperation(operationId) {
      sqlite.query("DELETE FROM oauth_pending_operation WHERE operation_id = ?").run(operationId);
    },
    compensateAccountOperation(operationId) {
      return sqlite
        .transaction(() => {
          const pending = selectPending.get(operationId);
          if (pending === null) return "superseded";
          let compensated = false;
          if (pending.kind === "create") {
            compensated =
              sqlite
                .query("DELETE FROM oauth_account WHERE provider_id = ? AND revision = ?")
                .run(pending.provider_id, pending.applied_revision).changes > 0;
          } else if (pending.kind === "update") {
            const current = selectAccount.get(pending.provider_id);
            if (current?.revision === pending.applied_revision && pending.rollback_json !== null) {
              const rollback = decodeJson<AccountOperationRollback>(pending.rollback_json);
              if (childSnapshotsEqual(childSnapshot(pending.provider_id), rollback.applied)) {
                restoreSnapshot(rollback.previous);
                compensated = true;
              }
            }
          } else {
            compensated = selectAccount.get(pending.provider_id)?.runtime_revision === pending.applied_revision;
          }
          sqlite.query("DELETE FROM oauth_pending_operation WHERE operation_id = ?").run(operationId);
          return compensated ? "compensated" : "superseded";
        })
        .immediate();
    },
    finalizeDeleteOperation(operationId) {
      return sqlite
        .transaction(() => {
          const pending = selectPending.get(operationId);
          if (pending === null || pending.kind !== "delete") return "superseded";
          const deleted =
            sqlite
              .query("DELETE FROM oauth_account WHERE provider_id = ? AND runtime_revision = ?")
              .run(pending.provider_id, pending.applied_revision).changes > 0;
          sqlite.query("DELETE FROM oauth_pending_operation WHERE operation_id = ?").run(operationId);
          return deleted ? "deleted" : "superseded";
        })
        .immediate();
    },
    listPendingAccountOperations() {
      return sqlite
        .query<PendingRow, []>(
          `SELECT operation_id, provider_id, kind, target_digest, applied_revision, previous_revision,
             rollback_json, created_at
           FROM oauth_pending_operation ORDER BY created_at, operation_id`,
        )
        .all()
        .map(pendingOperation);
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
    compareAndSwapCredential(providerId, expectedRevision, credential, metadata) {
      const encoded = encodeJson(credential);
      return sqlite
        .transaction(() => {
          const current = selectAccount.get(providerId);
          if (current === null || current.revision !== expectedRevision) return null;
          const result = sqlite
            .query(
              `UPDATE oauth_account SET credential_json = ?, revision = revision + 1, label = ?, expires_at = ?,
               updated_at = ? WHERE provider_id = ? AND revision = ?`,
            )
            .run(
              encoded,
              metadata?.label ?? current.label,
              metadata?.expiresAt ?? current.expires_at,
              Date.now(),
              providerId,
              expectedRevision,
            );
          if (result.changes === 0) return null;
          const updated = selectAccount.get(providerId);
          return updated === null ? null : storedAccount(updated);
        })
        .immediate();
    },
  };

  return repository;
}
