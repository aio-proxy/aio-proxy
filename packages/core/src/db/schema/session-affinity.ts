import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const sessionAffinity = sqliteTable(
  'session_affinity',
  {
    sessionSource: text('session_source').notNull(),
    sessionId: text('session_id').notNull(),
    requestedModelId: text('requested_model_id').notNull(),
    providerId: text('provider_id').notNull(),
    revision: integer('revision').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionSource, table.sessionId, table.requestedModelId] }),
    index('session_affinity_expires_idx').on(table.expiresAt),
  ],
);
