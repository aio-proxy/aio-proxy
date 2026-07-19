import type { Diagnostic } from "@aio-proxy/types";
import type { Database } from "bun:sqlite";

import { createAccountRows } from "./accounts";
import { createPluginStateRows } from "./plugin-state";
import {
  type AccountOperationRollback,
  type AccountRow,
  type ChildSnapshot,
  decodeJson,
  encodeJson,
  type PendingRow,
  pendingOperation,
  type RollbackSnapshot,
  storedAccount,
} from "./rows";
import { type PendingAccountOperation, PendingAccountOperationConflictError, type PluginRepository } from "./types";

export function createPendingOperationsRepository(
  sqlite: Database,
): Pick<
  PluginRepository,
  | "stageAccountOperation"
  | "completeAccountOperation"
  | "compensateAccountOperation"
  | "finalizeDeleteOperation"
  | "listPendingAccountOperations"
> {
  const accounts = createAccountRows(sqlite);
  const state = createPluginStateRows(sqlite);
  const selectPending = sqlite.query<PendingRow, [string]>(
    `SELECT operation_id, provider_id, kind, target_digest, applied_revision, previous_revision,
       rollback_json, created_at FROM oauth_pending_operation WHERE operation_id = ?`,
  );
  const childSnapshot = (providerId: string): ChildSnapshot => ({
    catalog: state.readCatalog(providerId),
    diagnostics: state.readDiagnostics(providerId),
  });
  const snapshot = (row: AccountRow): RollbackSnapshot => ({
    ...storedAccount(row),
    ...childSnapshot(row.provider_id),
  });
  const pendingForProvider = (providerId: string) =>
    sqlite
      .query<Pick<PendingRow, "operation_id" | "kind">, [string]>(
        "SELECT operation_id, kind FROM oauth_pending_operation WHERE provider_id = ? LIMIT 1",
      )
      .get(providerId);
  function restore(value: RollbackSnapshot): void {
    accounts.updateAccount(value, value.revision, value.runtimeRevision, value.updatedAt);
    sqlite.query("DELETE FROM oauth_catalog WHERE provider_id = ?").run(value.providerId);
    if (value.catalog !== null) state.replaceCatalog(value.providerId, value.catalog);
    sqlite.query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ?").run(value.providerId);
    for (const diagnostic of value.diagnostics) state.upsertDiagnostic(value.providerId, diagnostic as Diagnostic);
  }
  function insertPending(
    providerId: string,
    kind: PendingAccountOperation["kind"],
    targetDigest: string,
    appliedRevision: number,
    previousRevision?: number,
    rollback?: AccountOperationRollback,
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
  return {
    stageAccountOperation(input) {
      return sqlite
        .transaction(() => {
          if (input.kind === "create") {
            const pending = pendingForProvider(input.account.providerId);
            if (pending !== null)
              throw new PendingAccountOperationConflictError(input.account.providerId, pending.kind);
            accounts.insertAccount(input.account, 1, 1, Date.now());
            state.applyCatalog(input.account.providerId, input.account.catalog);
            sqlite
              .query(
                "DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = 'CREDENTIAL_REFRESH_FAILED'",
              )
              .run(input.account.providerId);
            return insertPending(input.account.providerId, "create", input.targetDigest, 1);
          }
          const providerId = input.kind === "update" ? input.account.providerId : input.providerId;
          const pending = pendingForProvider(providerId);
          if (pending !== null && (input.kind !== "delete" || pending.kind !== "delete")) {
            throw new PendingAccountOperationConflictError(providerId, pending.kind);
          }
          const current = accounts.selectAccount.get(providerId);
          if (current === null || current.runtime_revision !== input.expectedRuntimeRevision) {
            throw new Error("Account runtime revision mismatch");
          }
          const previous = snapshot(current);
          if (input.kind === "delete") {
            if (pending !== null)
              sqlite.query("DELETE FROM oauth_pending_operation WHERE operation_id = ?").run(pending.operation_id);
            return insertPending(providerId, "delete", input.targetDigest, current.runtime_revision, current.revision, {
              previous,
              applied: childSnapshot(providerId),
            });
          }
          const revision = current.revision + 1;
          accounts.updateAccount(input.account, revision, current.runtime_revision + 1, Date.now());
          state.applyCatalog(providerId, input.account.catalog);
          sqlite
            .query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = 'CREDENTIAL_REFRESH_FAILED'")
            .run(providerId);
          return insertPending(providerId, "update", input.targetDigest, revision, current.revision, {
            previous,
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
            const current = accounts.selectAccount.get(pending.provider_id);
            if (current?.revision === pending.applied_revision && pending.rollback_json !== null) {
              const rollback = decodeJson<AccountOperationRollback>(pending.rollback_json);
              if (encodeJson(childSnapshot(pending.provider_id)) === encodeJson(rollback.applied)) {
                restore(rollback.previous);
                compensated = true;
              }
            }
          } else {
            compensated =
              accounts.selectAccount.get(pending.provider_id)?.runtime_revision === pending.applied_revision;
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
             rollback_json, created_at FROM oauth_pending_operation ORDER BY created_at, operation_id`,
        )
        .all()
        .map(pendingOperation);
    },
  };
}
