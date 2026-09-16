import type { Database } from 'bun:sqlite';

import type { JsonValue } from '@aio-proxy/plugin-sdk';

import type { LocalBinding, LocalEntity, SyncRepository } from './repository';
import { parseEntityRow, parseJsonValue, stringifyJson } from './rows';

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
  connect_pending: number;
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
  oauth_json: unknown;
};

type LocalStateRepository = Pick<
  SyncRepository,
  | 'readBinding'
  | 'bindings'
  | 'clearBinding'
  | 'writeBinding'
  | 'setConnectPending'
  | 'entities'
  | 'putEntity'
  | 'putEntities'
>;

export function createSyncLocalStateRepository(
  sqlite: Database,
  transaction: <T>(callback: () => T) => T,
): LocalStateRepository {
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
      connectPending: row.connect_pending === 1,
    };
  }

  function setConnectPending(bindingId: string, pending: boolean): void {
    sqlite.run('UPDATE sync_binding SET connect_pending = ? WHERE id = ?', [pending ? 1 : 0, bindingId]);
  }

  function writeEntity(bindingId: string, entity: LocalEntity): void {
    sqlite
      .query(
        `INSERT INTO sync_entity
           (binding_id, object_id, logical_key, kind, mode, epoch, desired_json, baseline, overrides_json, pending_reason, oauth_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(binding_id, object_id) DO UPDATE SET
           logical_key = excluded.logical_key,
           kind = excluded.kind,
           mode = excluded.mode,
           epoch = excluded.epoch,
           desired_json = excluded.desired_json,
           baseline = excluded.baseline,
           overrides_json = excluded.overrides_json,
           pending_reason = excluded.pending_reason,
           oauth_json = excluded.oauth_json`,
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
        entity.oauth === undefined ? null : stringifyJson(entity.oauth as unknown as JsonValue),
      );
  }

  return {
    readBinding() {
      const row = sqlite
        .query<BindingRow, []>(
          `SELECT id, plugin, capability, plugin_version, identity_id, space_id, device_id,
                  session_generation, options_json, active, connect_pending
             FROM sync_binding WHERE active = 1 LIMIT 1`,
        )
        .get();
      return row === null ? null : toBinding(row);
    },

    bindings() {
      return sqlite.query<BindingRow, []>('SELECT * FROM sync_binding ORDER BY rowid').all().map(toBinding);
    },

    clearBinding() {
      transaction(() => {
        sqlite.run('UPDATE sync_binding SET active = 0 WHERE active = 1');
      });
    },

    writeBinding(binding) {
      transaction(() => {
        const existing = sqlite
          .query<BindingRow, [string]>(
            `SELECT id, plugin, capability, plugin_version, identity_id, space_id, device_id,
                    session_generation, options_json, active, connect_pending
               FROM sync_binding WHERE id = ?`,
          )
          .get(binding.id);
        if (
          existing !== null &&
          (existing.plugin !== binding.plugin ||
            existing.capability !== binding.capability ||
            existing.identity_id !== binding.identityId ||
            existing.space_id !== binding.spaceId)
        )
          throw new Error(`Conflicting sync binding identity: ${binding.id}`);
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
        // Left to the column default on insert (pending) and preserved on update: a new row belongs
        // to a connect whose reviewed Apply has not run yet, and rewriting an existing binding must
        // not silently declare that Apply finished.
        if (binding.connectPending !== undefined) setConnectPending(binding.id, binding.connectPending);
      });
    },

    setConnectPending(bindingId, pending) {
      transaction(() => setConnectPending(bindingId, pending));
    },

    entities(bindingId) {
      return sqlite
        .query<EntityRow, [string]>(
          `SELECT object_id, logical_key, kind, mode, epoch, desired_json, baseline, overrides_json, pending_reason, oauth_json
             FROM sync_entity WHERE binding_id = ? ORDER BY rowid`,
        )
        .all(bindingId)
        .map(parseEntityRow);
    },

    putEntity(bindingId, entity) {
      transaction(() => writeEntity(bindingId, entity));
    },

    putEntities(bindingId, entities) {
      transaction(() => {
        for (const entity of entities) writeEntity(bindingId, entity);
      });
    },
  };
}
