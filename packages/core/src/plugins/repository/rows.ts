import type { Diagnostic } from "@aio-proxy/types";

import type { PendingAccountOperation, StoredAccount, StoredAccountSummary, StoredCatalog } from "./types";

export type AccountRow = {
  readonly provider_id: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly options_json: string;
  readonly secret_json: string;
  readonly credential_json: string;
  readonly revision: number;
  readonly runtime_revision: number;
  readonly label: string | null;
  readonly expires_at: number | null;
  readonly updated_at: number;
};
export type AccountSummaryRow = Omit<AccountRow, "options_json" | "secret_json" | "credential_json">;
export type CatalogRow = { readonly catalog_json: string; readonly refreshed_at: number };
export type DiagnosticRow = { readonly diagnostic_json: string };
export type PluginSecretRow = { readonly value_json: string; readonly revision: number };
export type PendingRow = {
  readonly operation_id: string;
  readonly provider_id: string;
  readonly kind: "create" | "update" | "delete";
  readonly target_digest: string;
  readonly applied_revision: number;
  readonly previous_revision: number | null;
  readonly rollback_json: string | null;
  readonly created_at: number;
};
export type RollbackSnapshot = StoredAccount & {
  readonly catalog: StoredCatalog | null;
  readonly diagnostics: readonly Diagnostic[];
};
export type ChildSnapshot = Pick<RollbackSnapshot, "catalog" | "diagnostics">;
export type AccountOperationRollback = { readonly previous: RollbackSnapshot; readonly applied: ChildSnapshot };

export function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Plugin vault values must be JSON serializable");
  return encoded;
}
export function decodeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
export function storedAccount(row: AccountRow): StoredAccount {
  return {
    providerId: row.provider_id,
    plugin: row.plugin,
    capability: row.capability,
    fingerprint: row.fingerprint,
    options: decodeJson(row.options_json),
    secrets: decodeJson(row.secret_json),
    credential: decodeJson(row.credential_json),
    revision: row.revision,
    runtimeRevision: row.runtime_revision,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    updatedAt: row.updated_at,
  };
}
export function storedAccountSummary(row: AccountSummaryRow): StoredAccountSummary {
  return {
    providerId: row.provider_id,
    plugin: row.plugin,
    capability: row.capability,
    fingerprint: row.fingerprint,
    revision: row.revision,
    runtimeRevision: row.runtime_revision,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    updatedAt: row.updated_at,
  };
}
export function pendingOperation(row: PendingRow): PendingAccountOperation {
  return {
    operationId: row.operation_id,
    providerId: row.provider_id,
    kind: row.kind,
    targetDigest: row.target_digest,
    appliedRevision: row.applied_revision,
    ...(row.previous_revision === null ? {} : { previousRevision: row.previous_revision }),
    createdAt: row.created_at,
  };
}
export const ACCOUNT_COLUMNS = `provider_id, plugin, capability, fingerprint, options_json, secret_json,
  credential_json, revision, runtime_revision, label, expires_at, updated_at`;
export const ACCOUNT_SUMMARY_COLUMNS = `provider_id, plugin, capability, fingerprint, revision,
  runtime_revision, label, expires_at, updated_at`;
