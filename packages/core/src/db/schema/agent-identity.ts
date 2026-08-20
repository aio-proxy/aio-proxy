import type { AgentTarget } from '@aio-proxy/types';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const agentInstallation = sqliteTable('agent_installation', {
  installationId: text('installation_id').primaryKey(),
  target: text('target').$type<AgentTarget>().notNull(),
  createdAt: integer('created_at').notNull(),
  lastAuthorizedAt: integer('last_authorized_at').notNull(),
  adapterVersion: text('adapter_version').notNull(),
});

export const agentTokenFamily = sqliteTable(
  'agent_token_family',
  {
    familyId: text('family_id').primaryKey(),
    installationId: text('installation_id')
      .notNull()
      .references(() => agentInstallation.installationId, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    revokedAt: integer('revoked_at'),
    refreshExpiresAt: integer('refresh_expires_at').notNull(),
  },
  (table) => [
    index('agent_family_installation_idx').on(table.installationId),
    uniqueIndex('agent_family_one_current_idx')
      .on(table.installationId)
      .where(sql`${table.revokedAt} is null`),
  ],
);

export const agentAccessToken = sqliteTable(
  'agent_access_token',
  {
    tokenHash: text('token_hash').primaryKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => agentTokenFamily.familyId, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('agent_access_family_idx').on(table.familyId)],
);

export const agentRefreshToken = sqliteTable(
  'agent_refresh_token',
  {
    tokenHash: text('token_hash').primaryKey(),
    familyId: text('family_id')
      .notNull()
      .references(() => agentTokenFamily.familyId, { onDelete: 'cascade' }),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    consumedAt: integer('consumed_at'),
  },
  (table) => [index('agent_refresh_family_idx').on(table.familyId)],
);
