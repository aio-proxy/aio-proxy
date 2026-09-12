import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const syncBinding = sqliteTable(
  'sync_binding',
  {
    id: text('id').primaryKey(),
    plugin: text('plugin').notNull(),
    capability: text('capability').notNull(),
    pluginVersion: text('plugin_version').notNull(),
    identityId: text('identity_id').notNull(),
    spaceId: text('space_id').notNull(),
    deviceId: text('device_id').notNull(),
    sessionGeneration: integer('session_generation').notNull(),
    options: text('options_json', { mode: 'json' }).$type<unknown>().notNull(),
    active: integer('active').notNull().default(0),
    latestConfirmedCommit: integer('latest_confirmed_commit').notNull().default(0),
    // A binding row is only ever inserted by a connect whose reviewed decisions have not run yet,
    // so it is born pending and stays that way until the control plane finishes that Apply. The
    // flag is durable from the instant the binding exists, which is what a crash mid-Apply needs:
    // the restored lifecycle must not reconcile a backend the user never finished reviewing.
    connectPending: integer('connect_pending').notNull().default(1),
  },
  (table) => [
    check('sync_binding_space_check', sql`${table.spaceId} = 'default'`),
    check('sync_binding_active_check', sql`${table.active} in (0, 1)`),
    uniqueIndex('sync_binding_one_active_idx')
      .on(table.active)
      .where(sql`${table.active} = 1`),
  ],
);

export const syncEntity = sqliteTable(
  'sync_entity',
  {
    bindingId: text('binding_id').notNull(),
    objectId: text('object_id').notNull(),
    logicalKey: text('logical_key').notNull(),
    kind: text('kind').notNull(),
    mode: text('mode').notNull(),
    epoch: integer('epoch').notNull(),
    desired: text('desired_json', { mode: 'json' }).$type<unknown>(),
    baseline: text('baseline'),
    overrides: text('overrides_json', { mode: 'json' }).$type<unknown>().notNull(),
    pendingReason: text('pending_reason'),
    oauth: text('oauth_json', { mode: 'json' }).$type<unknown>(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.objectId] }),
    index('sync_entity_binding_idx').on(table.bindingId),
    check('sync_entity_mode_check', sql`${table.mode} in ('included', 'excluded')`),
  ],
);

export const syncCommit = sqliteTable(
  'sync_commit',
  {
    bindingId: text('binding_id').notNull(),
    commitId: text('commit_id').notNull(),
    origin: text('origin').notNull(),
    beforeDigest: text('before_digest').notNull(),
    afterDigest: text('after_digest').notNull(),
    rawAfter: text('raw_after_json', { mode: 'json' }).$type<unknown>().notNull(),
    accountOperationIds: text('account_operation_ids_json', { mode: 'json' }).$type<unknown>().notNull(),
    phase: text('phase').notNull(),
    remoteOperations: text('remote_operations_json', { mode: 'json' }).$type<unknown>(),
    pluginSecrets: text('plugin_secrets_json', { mode: 'json' }).$type<unknown>(),
    sourceRevisions: text('source_revisions_json', { mode: 'json' }).$type<unknown>(),
    confirmedOrder: integer('confirmed_order'),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.commitId] }),
    index('sync_commit_pending_idx').on(table.bindingId, table.phase),
    check('sync_commit_origin_check', sql`${table.origin} in ('local', 'remote')`),
    check('sync_commit_phase_check', sql`${table.phase} in ('prepared', 'confirmed')`),
  ],
);

export const syncOutbox = sqliteTable(
  'sync_outbox',
  {
    bindingId: text('binding_id').notNull(),
    operationId: text('operation_id').notNull(),
    objectId: text('object_id').notNull(),
    epoch: integer('epoch').notNull(),
    kind: text('kind').notNull(),
    body: text('body_json', { mode: 'json' }).$type<unknown>(),
    commitId: text('commit_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.operationId] }),
    index('sync_outbox_binding_idx').on(table.bindingId),
    check('sync_outbox_kind_check', sql`${table.kind} in ('put', 'delete')`),
  ],
);

export const syncOAuthJournal = sqliteTable(
  'sync_oauth_journal',
  {
    bindingId: text('binding_id').notNull(),
    operationId: text('operation_id').notNull(),
    objectId: text('object_id').notNull(),
    epoch: integer('epoch').notNull(),
    baseGeneration: integer('base_generation').notNull(),
    phase: text('phase').notNull(),
    payload: text('payload_json', { mode: 'json' }).$type<unknown>(),
  },
  (table) => [
    primaryKey({ columns: [table.bindingId, table.operationId] }),
    index('sync_oauth_journal_binding_idx').on(table.bindingId),
    check('sync_oauth_journal_phase_check', sql`${table.phase} in ('started', 'result', 'complete')`),
  ],
);
