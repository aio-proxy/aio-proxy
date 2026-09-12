import { Database } from 'bun:sqlite';

import { isEqual } from 'es-toolkit/predicate';

import type { OAuthJournalRow } from './repository';
import { parseOAuthJournalRow, stringifyJson } from './rows';

type OAuthRow = {
  operation_id: string;
  object_id: string;
  epoch: number;
  base_generation: number;
  phase: string;
  payload_json: unknown;
};

type Transaction = <T>(callback: () => T) => T;

function phaseOrder(phase: OAuthJournalRow['phase']): number {
  return phase === 'started' ? 0 : phase === 'result' ? 1 : 2;
}

function ensureFullSynchronous(sqlite: Database): void {
  if (!sqlite.inTransaction) sqlite.run('PRAGMA synchronous = FULL');
  const value = Object.values(sqlite.query('PRAGMA synchronous').get() ?? {}).at(0);
  if (value !== 2) throw new Error('SQLite synchronous=FULL could not be established for the OAuth journal');
}

export interface OAuthJournalRepository {
  writeOAuthJournal(bindingId: string, row: OAuthJournalRow): void;
  clearOAuthJournal(bindingId: string, operationId: string): void;
  oauthJournals(bindingId: string): OAuthJournalRow[];
}

export function createOAuthJournalRepository(sqlite: Database, transaction: Transaction): OAuthJournalRepository {
  return {
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
            if (!isEqual(stored.payload, row.payload)) {
              throw new Error(`Conflicting sync OAuth journal result: ${row.operationId}`);
            }
            return;
          }
          if (stored.phase === 'result' && !isEqual(stored.payload, row.payload)) {
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

    clearOAuthJournal(bindingId, operationId) {
      transaction(() => {
        const row = sqlite
          .query<{ phase: string }, [string, string]>(
            'SELECT phase FROM sync_oauth_journal WHERE binding_id = ? AND operation_id = ?',
          )
          .get(bindingId, operationId);
        if (row === null) return;
        if (row.phase !== 'complete') throw new Error(`Cannot clear incomplete sync OAuth journal: ${operationId}`);
        sqlite
          .query('DELETE FROM sync_oauth_journal WHERE binding_id = ? AND operation_id = ?')
          .run(bindingId, operationId);
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
