import { Database } from 'bun:sqlite';

import type { JsonValue } from '@aio-proxy/plugin-sdk';

import type { OAuthOwnership } from '../oauth';
import type { EntityBody, EntityKind } from '../protocol';
import { createSyncLocalStateRepository } from './local-state';
import { createOAuthJournalRepository } from './oauth-journal';
import { parseCommitRow, parseOutboxRow, stringifyJson } from './rows';

export interface LocalBinding {
  id: string;
  plugin: string;
  capability: string;
  pluginVersion: string;
  identityId: string;
  spaceId: 'default';
  deviceId: string;
  sessionGeneration: number;
  options: JsonValue;
}

export interface LocalOverride {
  path: string[];
  value: JsonValue | undefined;
}

export interface LocalEntity {
  objectId: string;
  logicalKey: string;
  kind: EntityKind;
  mode: 'included' | 'excluded';
  epoch: number;
  desired: EntityBody | null;
  baseline: string | null;
  overrides: LocalOverride[];
  pendingReason: string | null;
  oauth?: OAuthOwnership;
}

export interface OutboxOperation {
  operationId: string;
  objectId: string;
  epoch: number;
  kind: 'put' | 'delete';
  body: EntityBody | null;
  commitId: string;
}

export interface CommitIntent {
  commitId: string;
  origin: 'local' | 'remote';
  beforeDigest: string;
  afterDigest: string;
  rawAfter: JsonValue;
  accountOperationIds: string[];
  phase: 'prepared' | 'confirmed';
  remoteOperations?: { objectId: string; operationId: string }[];
  sourceRevisions?: Record<string, number>;
}

export interface OAuthJournalRow {
  operationId: string;
  objectId: string;
  epoch: number;
  baseGeneration: number;
  phase: 'started' | 'result' | 'complete';
  payload: JsonValue | null;
}

export interface SyncRepository {
  readBinding(): LocalBinding | null;
  bindings(): LocalBinding[];
  clearBinding?(): void;
  writeBinding(binding: LocalBinding): void;
  entities(bindingId: string): LocalEntity[];
  putEntity(bindingId: string, entity: LocalEntity): void;
  putEntities?(bindingId: string, entities: readonly LocalEntity[]): void;
  prepare(bindingId: string, intent: CommitIntent): void;
  readCommit(bindingId: string, commitId: string): CommitIntent | null;
  latestConfirmedCommit(bindingId: string): CommitIntent | null;
  pendingCommits(bindingId: string): CommitIntent[];
  confirm(
    bindingId: string,
    commitId: string,
    operations: OutboxOperation[],
    sourceRevisions?: Record<string, number>,
  ): void;
  discard(bindingId: string, commitId: string): void;
  outbox(bindingId: string): OutboxOperation[];
  acknowledge(bindingId: string, operationId: string): void;
  writeOAuthJournal(bindingId: string, row: OAuthJournalRow): void;
  clearOAuthJournal(bindingId: string, operationId: string): void;
  oauthJournals(bindingId: string): OAuthJournalRow[];
}

type CommitRow = {
  commit_id: string;
  origin: string;
  before_digest: string;
  after_digest: string;
  raw_after_json: unknown;
  account_operation_ids_json: unknown;
  phase: string;
  remote_operations_json: unknown;
  source_revisions_json: unknown;
};

type OutboxRow = {
  operation_id: string;
  object_id: string;
  epoch: number;
  kind: string;
  body_json: unknown;
  commit_id: string;
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCommitIntent(left: CommitIntent, right: CommitIntent): boolean {
  return (
    left.commitId === right.commitId &&
    left.origin === right.origin &&
    left.beforeDigest === right.beforeDigest &&
    left.afterDigest === right.afterDigest &&
    sameJson(left.rawAfter, right.rawAfter) &&
    sameJson(left.accountOperationIds, right.accountOperationIds) &&
    sameJson(left.remoteOperations, right.remoteOperations) &&
    sameJson(left.sourceRevisions, right.sourceRevisions)
  );
}

function sameOutboxOperation(left: OutboxOperation, right: OutboxOperation): boolean {
  return (
    left.operationId === right.operationId &&
    left.objectId === right.objectId &&
    left.epoch === right.epoch &&
    left.kind === right.kind &&
    sameJson(left.body, right.body) &&
    left.commitId === right.commitId
  );
}

// The repository methods are deliberately kept together so every mutation uses the same transaction wrapper.
// eslint-disable-next-line max-lines-per-function
export function createSyncRepository(sqlite: Database): SyncRepository {
  const transaction = <T>(callback: () => T): T => sqlite.transaction(callback)();
  const oauthJournal = createOAuthJournalRepository(sqlite, transaction);
  const localState = createSyncLocalStateRepository(sqlite, transaction);

  function readCommitRow(bindingId: string, commitId: string): CommitRow | null {
    return (
      sqlite
        .query<CommitRow, [string, string]>(
          `SELECT commit_id, origin, before_digest, after_digest, raw_after_json,
                account_operation_ids_json, phase, remote_operations_json, source_revisions_json
           FROM sync_commit WHERE binding_id = ? AND commit_id = ?`,
        )
        .get(bindingId, commitId) ?? null
    );
  }

  return {
    ...localState,

    prepare(bindingId, intent) {
      if (intent.phase !== 'prepared') throw new TypeError('Sync intents must be prepared before confirmation');
      transaction(() => {
        const existing = readCommitRow(bindingId, intent.commitId);
        if (existing !== null) {
          const stored = parseCommitRow(existing);
          if (!sameCommitIntent(stored, intent)) throw new Error(`Conflicting sync commit: ${intent.commitId}`);
          return;
        }
        sqlite
          .query(
            `INSERT INTO sync_commit
             (binding_id, commit_id, origin, before_digest, after_digest, raw_after_json,
              account_operation_ids_json, phase, remote_operations_json, source_revisions_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
           ON CONFLICT(binding_id, commit_id) DO NOTHING`,
          )
          .run(
            bindingId,
            intent.commitId,
            intent.origin,
            intent.beforeDigest,
            intent.afterDigest,
            stringifyJson(intent.rawAfter),
            stringifyJson(intent.accountOperationIds as unknown as JsonValue),
            intent.remoteOperations === undefined
              ? null
              : stringifyJson(intent.remoteOperations as unknown as JsonValue),
            intent.sourceRevisions === undefined ? null : stringifyJson(intent.sourceRevisions as unknown as JsonValue),
          );
      });
    },

    readCommit(bindingId, commitId) {
      const row = readCommitRow(bindingId, commitId);
      return row === null ? null : parseCommitRow(row);
    },

    latestConfirmedCommit(bindingId) {
      const row = sqlite
        .query<CommitRow, [string]>(
          `SELECT commit_id, origin, before_digest, after_digest, raw_after_json,
                  account_operation_ids_json, phase, remote_operations_json, source_revisions_json
             FROM sync_commit
            WHERE binding_id = ? AND phase = 'confirmed'
            ORDER BY confirmed_order DESC LIMIT 1`,
        )
        .get(bindingId);
      return row === null ? null : parseCommitRow(row);
    },

    pendingCommits(bindingId) {
      return sqlite
        .query<CommitRow, [string]>(
          `SELECT commit_id, origin, before_digest, after_digest, raw_after_json,
                  account_operation_ids_json, phase, remote_operations_json, source_revisions_json
             FROM sync_commit WHERE binding_id = ? AND phase = 'prepared' ORDER BY rowid`,
        )
        .all(bindingId)
        .map(parseCommitRow);
    },

    confirm(bindingId, commitId, operations, sourceRevisions) {
      transaction(() => {
        const row = readCommitRow(bindingId, commitId);
        if (row === null) throw new Error(`Unknown sync commit: ${commitId}`);
        const saved = parseCommitRow(row);
        if (saved.phase === 'confirmed') return;
        if (saved.origin === 'remote' && operations.length > 0) {
          throw new Error('Remote sync commits cannot create outbox operations');
        }
        for (const operation of operations) {
          if (operation.commitId !== commitId) throw new Error('Outbox operation belongs to another commit');
          if ((operation.kind === 'put') !== (operation.body !== null)) {
            throw new Error('Put operations require a body and delete operations require null body');
          }
          const existing = sqlite
            .query<OutboxRow, [string, string]>(
              `SELECT operation_id, object_id, epoch, kind, body_json, commit_id
                 FROM sync_outbox WHERE binding_id = ? AND operation_id = ?`,
            )
            .get(bindingId, operation.operationId);
          if (existing !== null) {
            if (!sameOutboxOperation(parseOutboxRow(existing), operation)) {
              throw new Error(`Conflicting sync outbox operation: ${operation.operationId}`);
            }
            continue;
          }
          sqlite
            .query(
              `INSERT INTO sync_outbox (binding_id, operation_id, object_id, epoch, kind, body_json, commit_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             `,
            )
            .run(
              bindingId,
              operation.operationId,
              operation.objectId,
              operation.epoch,
              operation.kind,
              operation.body === null ? null : stringifyJson(operation.body as unknown as JsonValue),
              operation.commitId,
            );
        }

        const confirmedOrder =
          sqlite
            .query<{ next_order: number }, [string]>(
              'SELECT COALESCE(MAX(confirmed_order), 0) + 1 AS next_order FROM sync_commit WHERE binding_id = ?',
            )
            .get(bindingId)?.next_order ?? 1;
        const revisions = sourceRevisions === undefined ? saved.sourceRevisions : sourceRevisions;
        sqlite
          .query(
            `UPDATE sync_commit
              SET phase = 'confirmed', source_revisions_json = ?, confirmed_order = ?
            WHERE binding_id = ? AND commit_id = ?`,
          )
          .run(
            revisions === undefined ? null : stringifyJson(revisions as unknown as JsonValue),
            confirmedOrder,
            bindingId,
            commitId,
          );
        sqlite.query(`UPDATE sync_binding SET latest_confirmed_commit = ? WHERE id = ?`).run(confirmedOrder, bindingId);

        for (const remoteOperation of saved.remoteOperations ?? []) {
          sqlite
            .query(`UPDATE sync_entity SET baseline = ? WHERE binding_id = ? AND object_id = ?`)
            .run(remoteOperation.operationId, bindingId, remoteOperation.objectId);
        }
      });
    },

    discard(bindingId, commitId) {
      transaction(() => {
        sqlite
          .query("DELETE FROM sync_commit WHERE binding_id = ? AND commit_id = ? AND phase = 'prepared'")
          .run(bindingId, commitId);
      });
    },

    outbox(bindingId) {
      return sqlite
        .query<OutboxRow, [string]>(
          `SELECT operation_id, object_id, epoch, kind, body_json, commit_id
             FROM sync_outbox WHERE binding_id = ? ORDER BY rowid`,
        )
        .all(bindingId)
        .map(parseOutboxRow);
    },

    acknowledge(bindingId, operationId) {
      transaction(() => {
        sqlite.query('DELETE FROM sync_outbox WHERE binding_id = ? AND operation_id = ?').run(bindingId, operationId);
      });
    },

    writeOAuthJournal: oauthJournal.writeOAuthJournal,
    clearOAuthJournal: oauthJournal.clearOAuthJournal,
    oauthJournals: oauthJournal.oauthJournals,
  };
}
