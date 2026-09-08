import { Database } from 'bun:sqlite';

import type { JsonValue } from '@aio-proxy/plugin-sdk';

import type { EntityBody, EntityKind } from '../protocol';
import {
  parseCommitRow,
  parseEntityRow,
  parseJsonValue,
  parseOAuthJournalRow,
  parseOutboxRow,
  stringifyJson,
} from './rows';

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
  writeBinding(binding: LocalBinding): void;
  entities(bindingId: string): LocalEntity[];
  putEntity(bindingId: string, entity: LocalEntity): void;
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
  oauthJournals(bindingId: string): OAuthJournalRow[];
}

type BindingRow = {
  id: string;
  plugin: string;
  capability: string;
  plugin_version: string;
  identity_id: string;
  space_id: string;
  device_id: string;
  session_generation: number;
  options_json: unknown;
  active: number;
};

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

type EntityRow = {
  object_id: string;
  logical_key: string;
  kind: string;
  mode: string;
  epoch: number;
  desired_json: unknown;
  baseline: string | null;
  overrides_json: unknown;
  pending_reason: string | null;
};

type OutboxRow = {
  operation_id: string;
  object_id: string;
  epoch: number;
  kind: string;
  body_json: unknown;
  commit_id: string;
};

type OAuthRow = {
  operation_id: string;
  object_id: string;
  epoch: number;
  base_generation: number;
  phase: string;
  payload_json: unknown;
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

function phaseOrder(phase: OAuthJournalRow['phase']): number {
  return phase === 'started' ? 0 : phase === 'result' ? 1 : 2;
}

function ensureFullSynchronous(sqlite: Database): void {
  sqlite.run('PRAGMA synchronous = FULL');
  const value = Object.values(sqlite.query('PRAGMA synchronous').get() ?? {}).at(0);
  if (value !== 2) throw new Error('SQLite synchronous=FULL could not be established for the OAuth journal');
}

// The repository methods are deliberately kept together so every mutation uses the same transaction wrapper.
// eslint-disable-next-line max-lines-per-function
export function createSyncRepository(sqlite: Database): SyncRepository {
  const transaction = <T>(callback: () => T): T => sqlite.transaction(callback)();

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

  function toBinding(row: BindingRow): LocalBinding {
    if (row.space_id !== 'default') throw new TypeError('Invalid sync binding space');
    return {
      id: row.id,
      plugin: row.plugin,
      capability: row.capability,
      pluginVersion: row.plugin_version,
      identityId: row.identity_id,
      spaceId: 'default',
      deviceId: row.device_id,
      sessionGeneration: row.session_generation,
      options: parseJsonValue(row.options_json),
    };
  }

  return {
    readBinding() {
      const row = sqlite
        .query<BindingRow, []>(
          `SELECT id, plugin, capability, plugin_version, identity_id, space_id, device_id,
                  session_generation, options_json, active
             FROM sync_binding WHERE active = 1 LIMIT 1`,
        )
        .get();
      return row === null ? null : toBinding(row);
    },

    writeBinding(binding) {
      transaction(() => {
        sqlite.run('UPDATE sync_binding SET active = 0 WHERE active = 1');
        sqlite
          .query(
            `INSERT INTO sync_binding
             (id, plugin, capability, plugin_version, identity_id, space_id, device_id,
              session_generation, options_json, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(id) DO UPDATE SET
             plugin = excluded.plugin,
             capability = excluded.capability,
             plugin_version = excluded.plugin_version,
             identity_id = excluded.identity_id,
             space_id = excluded.space_id,
             device_id = excluded.device_id,
             session_generation = excluded.session_generation,
             options_json = excluded.options_json,
             active = 1`,
          )
          .run(
            binding.id,
            binding.plugin,
            binding.capability,
            binding.pluginVersion,
            binding.identityId,
            binding.spaceId,
            binding.deviceId,
            binding.sessionGeneration,
            stringifyJson(binding.options),
          );
      });
    },

    entities(bindingId) {
      return sqlite
        .query<EntityRow, [string]>(
          `SELECT object_id, logical_key, kind, mode, epoch, desired_json, baseline, overrides_json, pending_reason
             FROM sync_entity WHERE binding_id = ? ORDER BY rowid`,
        )
        .all(bindingId)
        .map(parseEntityRow);
    },

    putEntity(bindingId, entity) {
      transaction(() => {
        sqlite
          .query(
            `INSERT INTO sync_entity
             (binding_id, object_id, logical_key, kind, mode, epoch, desired_json, baseline, overrides_json, pending_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(binding_id, object_id) DO UPDATE SET
             logical_key = excluded.logical_key,
             kind = excluded.kind,
             mode = excluded.mode,
             epoch = excluded.epoch,
             desired_json = excluded.desired_json,
             baseline = excluded.baseline,
             overrides_json = excluded.overrides_json,
             pending_reason = excluded.pending_reason`,
          )
          .run(
            bindingId,
            entity.objectId,
            entity.logicalKey,
            entity.kind,
            entity.mode,
            entity.epoch,
            entity.desired === null ? null : stringifyJson(entity.desired as unknown as JsonValue),
            entity.baseline,
            stringifyJson(entity.overrides as unknown as JsonValue),
            entity.pendingReason,
          );
      });
    },

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

    writeOAuthJournal(bindingId, row) {
      ensureFullSynchronous(sqlite);
      transaction(() => {
        const existing = sqlite
          .query<OAuthRow, [string, string]>(
            `SELECT operation_id, object_id, epoch, base_generation, phase, payload_json
               FROM sync_oauth_journal WHERE binding_id = ? AND operation_id = ?`,
          )
          .get(bindingId, row.operationId);
        if (existing !== null) {
          const stored = parseOAuthJournalRow(existing);
          if (
            stored.objectId !== row.objectId ||
            stored.epoch !== row.epoch ||
            stored.baseGeneration !== row.baseGeneration
          ) {
            throw new Error(`Conflicting sync OAuth journal identity: ${row.operationId}`);
          }
          const currentOrder = phaseOrder(stored.phase);
          const nextOrder = phaseOrder(row.phase);
          if (nextOrder < currentOrder) throw new Error(`Stale sync OAuth journal phase: ${row.operationId}`);
          if (nextOrder === currentOrder) {
            if (!sameJson(stored.payload, row.payload)) {
              throw new Error(`Conflicting sync OAuth journal result: ${row.operationId}`);
            }
            return;
          }
          if (stored.phase === 'result' && !sameJson(stored.payload, row.payload)) {
            throw new Error(`Conflicting sync OAuth journal result: ${row.operationId}`);
          }
          sqlite
            .query(
              `UPDATE sync_oauth_journal SET phase = ?, payload_json = ?
                 WHERE binding_id = ? AND operation_id = ?`,
            )
            .run(row.phase, row.payload === null ? null : stringifyJson(row.payload), bindingId, row.operationId);
          return;
        }
        sqlite
          .query(
            `INSERT INTO sync_oauth_journal
             (binding_id, operation_id, object_id, epoch, base_generation, phase, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            bindingId,
            row.operationId,
            row.objectId,
            row.epoch,
            row.baseGeneration,
            row.phase,
            row.payload === null ? null : stringifyJson(row.payload),
          );
      });
    },

    oauthJournals(bindingId) {
      return sqlite
        .query<OAuthRow, [string]>(
          `SELECT operation_id, object_id, epoch, base_generation, phase, payload_json
             FROM sync_oauth_journal WHERE binding_id = ? ORDER BY rowid`,
        )
        .all(bindingId)
        .map(parseOAuthJournalRow);
    },
  };
}
