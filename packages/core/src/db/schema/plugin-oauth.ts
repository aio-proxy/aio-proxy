import type { ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { Diagnostic, DiagnosticCode } from "@aio-proxy/types";
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const pluginSecret = sqliteTable("plugin_secret", {
  plugin: text("plugin").primaryKey(),
  value: text("value_json", { mode: "json" }).$type<unknown>().notNull(),
  revision: integer("revision").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const oauthAccount = sqliteTable(
  "oauth_account",
  {
    providerId: text("provider_id").primaryKey(),
    plugin: text("plugin").notNull(),
    capability: text("capability").notNull(),
    fingerprint: text("fingerprint").notNull(),
    options: text("options_json", { mode: "json" }).$type<unknown>().notNull(),
    secrets: text("secret_json", { mode: "json" }).$type<unknown>().notNull(),
    credential: text("credential_json", { mode: "json" }).$type<unknown>().notNull(),
    revision: integer("revision").notNull(),
    runtimeRevision: integer("runtime_revision").notNull(),
    label: text("label"),
    expiresAt: integer("expires_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.plugin, table.capability, table.fingerprint),
    index("oauth_account_fingerprint_idx").on(table.plugin, table.capability, table.fingerprint),
  ],
);

export const oauthCatalog = sqliteTable("oauth_catalog", {
  providerId: text("provider_id")
    .primaryKey()
    .references(() => oauthAccount.providerId, { onDelete: "cascade" }),
  catalog: text("catalog_json", { mode: "json" }).$type<ModelCatalog>().notNull(),
  refreshedAt: integer("refreshed_at").notNull(),
});

export const oauthAccountDiagnostic = sqliteTable(
  "oauth_account_diagnostic",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => oauthAccount.providerId, { onDelete: "cascade" }),
    code: text("code").$type<DiagnosticCode>().notNull(),
    diagnostic: text("diagnostic_json", { mode: "json" }).$type<Diagnostic>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.code] })],
);

export const oauthRefreshLease = sqliteTable("oauth_refresh_lease", {
  providerId: text("provider_id")
    .primaryKey()
    .references(() => oauthAccount.providerId, { onDelete: "cascade" }),
  owner: text("owner").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const oauthPendingOperation = sqliteTable(
  "oauth_pending_operation",
  {
    operationId: text("operation_id").primaryKey(),
    providerId: text("provider_id").notNull(),
    kind: text("kind").$type<"create" | "update" | "delete">().notNull(),
    targetDigest: text("target_digest").notNull(),
    appliedRevision: integer("applied_revision").notNull(),
    previousRevision: integer("previous_revision"),
    rollback: text("rollback_json", { mode: "json" }).$type<unknown>(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check("oauth_pending_operation_kind_check", sql`${table.kind} in ('create', 'update', 'delete')`),
    index("oauth_pending_created_at_idx").on(table.createdAt),
    index("oauth_pending_provider_idx").on(table.providerId),
  ],
);
