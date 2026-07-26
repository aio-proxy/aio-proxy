import type { Database } from 'bun:sqlite';

import type { Diagnostic } from '@aio-proxy/types';

import { createAccountRows } from './accounts';
import { createPluginStateRows } from './plugin-state';
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
} from './rows';
import type { AccountWrite } from './types';
import { type PendingAccountOperation, PendingAccountOperationConflictError, type PluginRepository } from './types';

type RowQuery<Row> = { readonly get: (param: string) => Row | null };
type AccountRowWrite = Omit<AccountWrite, 'catalog'>;

type PendingOpsDeps = {
  readonly sqlite: Database;
  readonly selectPending: RowQuery<PendingRow>;
  readonly selectAccount: RowQuery<AccountRow>;
  readonly insertAccount: (
    value: AccountRowWrite,
    revision: number,
    runtimeRevision: number,
    updatedAt: number,
  ) => void;
  readonly updateAccount: (
    value: AccountRowWrite,
    revision: number,
    runtimeRevision: number,
    updatedAt: number,
  ) => void;
  readonly applyCatalog: (providerId: string, value: AccountWrite['catalog']) => void;
  readonly childSnapshot: (providerId: string) => ChildSnapshot;
  readonly snapshot: (row: AccountRow) => RollbackSnapshot;
  readonly restore: (value: RollbackSnapshot) => void;
  readonly insertPending: (
    providerId: string,
    kind: PendingAccountOperation['kind'],
    targetDigest: string,
    appliedRevision: number,
    previousRevision?: number,
    rollback?: AccountOperationRollback,
  ) => PendingAccountOperation;
  readonly pendingForProvider: (providerId: string) => Pick<PendingRow, 'operation_id' | 'kind'> | null;
};

type StageInput = Parameters<PluginRepository['stageAccountOperation']>[0];

function stageAccountOperation(deps: PendingOpsDeps, input: StageInput): PendingAccountOperation {
  const { sqlite } = deps;
  return sqlite
    .transaction(() => {
      if (input.kind === 'create') {
        const pending = deps.pendingForProvider(input.account.providerId);
        if (pending !== null) throw new PendingAccountOperationConflictError(input.account.providerId, pending.kind);
        deps.insertAccount(input.account, 1, 1, Date.now());
        deps.applyCatalog(input.account.providerId, input.account.catalog);
        sqlite
          .query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = 'CREDENTIAL_REFRESH_FAILED'")
          .run(input.account.providerId);
        return deps.insertPending(input.account.providerId, 'create', input.targetDigest, 1);
      }
      const providerId = input.kind === 'update' ? input.account.providerId : input.providerId;
      const pending = deps.pendingForProvider(providerId);
      if (pending !== null && (input.kind !== 'delete' || pending.kind !== 'delete')) {
        throw new PendingAccountOperationConflictError(providerId, pending.kind);
      }
      const current = deps.selectAccount.get(providerId);
      if (current === null || current.runtime_revision !== input.expectedRuntimeRevision) {
        throw new Error('Account runtime revision mismatch');
      }
      const previous = deps.snapshot(current);
      if (input.kind === 'delete') {
        if (pending !== null)
          sqlite.query('DELETE FROM oauth_pending_operation WHERE operation_id = ?').run(pending.operation_id);
        return deps.insertPending(
          providerId,
          'delete',
          input.targetDigest,
          current.runtime_revision,
          current.revision,
          {
            previous,
            applied: deps.childSnapshot(providerId),
          },
        );
      }
      const revision = current.revision + 1;
      deps.updateAccount(input.account, revision, current.runtime_revision + 1, Date.now());
      deps.applyCatalog(providerId, input.account.catalog);
      sqlite
        .query("DELETE FROM oauth_account_diagnostic WHERE provider_id = ? AND code = 'CREDENTIAL_REFRESH_FAILED'")
        .run(providerId);
      return deps.insertPending(providerId, 'update', input.targetDigest, revision, current.revision, {
        previous,
        applied: deps.childSnapshot(providerId),
      });
    })
    .immediate();
}

function compensateAccountOperation(deps: PendingOpsDeps, operationId: string): 'compensated' | 'superseded' {
  const { sqlite } = deps;
  return sqlite
    .transaction(() => {
      const pending = deps.selectPending.get(operationId);
      if (pending === null) return 'superseded';
      let compensated = false;
      if (pending.kind === 'create') {
        compensated =
          sqlite
            .query('DELETE FROM oauth_account WHERE provider_id = ? AND revision = ?')
            .run(pending.provider_id, pending.applied_revision).changes > 0;
      } else if (pending.kind === 'update') {
        const current = deps.selectAccount.get(pending.provider_id);
        if (current?.revision === pending.applied_revision && pending.rollback_json !== null) {
          const rollback = decodeJson<AccountOperationRollback>(pending.rollback_json);
          if (encodeJson(deps.childSnapshot(pending.provider_id)) === encodeJson(rollback.applied)) {
            deps.restore(rollback.previous);
            compensated = true;
          }
        }
      } else {
        compensated = deps.selectAccount.get(pending.provider_id)?.runtime_revision === pending.applied_revision;
      }
      sqlite.query('DELETE FROM oauth_pending_operation WHERE operation_id = ?').run(operationId);
      return compensated ? 'compensated' : 'superseded';
    })
    .immediate();
}

function finalizeDeleteOperation(
  sqlite: Database,
  selectPending: RowQuery<PendingRow>,
  operationId: string,
): 'deleted' | 'superseded' {
  return sqlite
    .transaction(() => {
      const pending = selectPending.get(operationId);
      if (pending === null || pending.kind !== 'delete') return 'superseded';
      const deleted =
        sqlite
          .query('DELETE FROM oauth_account WHERE provider_id = ? AND runtime_revision = ?')
          .run(pending.provider_id, pending.applied_revision).changes > 0;
      sqlite.query('DELETE FROM oauth_pending_operation WHERE operation_id = ?').run(operationId);
      return deleted ? 'deleted' : 'superseded';
    })
    .immediate();
}

function listPendingAccountOperations(sqlite: Database): readonly PendingAccountOperation[] {
  return sqlite
    .query<PendingRow, []>(
      `SELECT operation_id, provider_id, kind, target_digest, applied_revision, previous_revision,
         rollback_json, created_at FROM oauth_pending_operation ORDER BY created_at, operation_id`,
    )
    .all()
    .map(pendingOperation);
}

export function createPendingOperationsRepository(
  sqlite: Database,
): Pick<
  PluginRepository,
  | 'stageAccountOperation'
  | 'completeAccountOperation'
  | 'compensateAccountOperation'
  | 'finalizeDeleteOperation'
  | 'listPendingAccountOperations'
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
      .query<Pick<PendingRow, 'operation_id' | 'kind'>, [string]>(
        'SELECT operation_id, kind FROM oauth_pending_operation WHERE provider_id = ? LIMIT 1',
      )
      .get(providerId);
  function restore(value: RollbackSnapshot): void {
    accounts.updateAccount(value, value.revision, value.runtimeRevision, value.updatedAt);
    sqlite.query('DELETE FROM oauth_catalog WHERE provider_id = ?').run(value.providerId);
    if (value.catalog !== null) state.replaceCatalog(value.providerId, value.catalog);
    sqlite.query('DELETE FROM oauth_account_diagnostic WHERE provider_id = ?').run(value.providerId);
    for (const diagnostic of value.diagnostics) state.upsertDiagnostic(value.providerId, diagnostic as Diagnostic);
  }
  function insertPending(
    providerId: string,
    kind: PendingAccountOperation['kind'],
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
  const deps: PendingOpsDeps = {
    sqlite,
    selectPending,
    selectAccount: accounts.selectAccount,
    insertAccount: accounts.insertAccount,
    updateAccount: accounts.updateAccount,
    applyCatalog: state.applyCatalog,
    childSnapshot,
    snapshot,
    restore,
    insertPending,
    pendingForProvider,
  };
  return {
    stageAccountOperation(input) {
      return stageAccountOperation(deps, input);
    },
    completeAccountOperation(operationId) {
      sqlite.query('DELETE FROM oauth_pending_operation WHERE operation_id = ?').run(operationId);
    },
    compensateAccountOperation(operationId) {
      return compensateAccountOperation(deps, operationId);
    },
    finalizeDeleteOperation(operationId) {
      return finalizeDeleteOperation(sqlite, selectPending, operationId);
    },
    listPendingAccountOperations() {
      return listPendingAccountOperations(sqlite);
    },
  };
}
