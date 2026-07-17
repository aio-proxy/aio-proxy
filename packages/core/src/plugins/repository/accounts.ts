import type { Database } from "bun:sqlite";
import {
  ACCOUNT_COLUMNS,
  ACCOUNT_SUMMARY_COLUMNS,
  type AccountRow,
  type AccountSummaryRow,
  encodeJson,
  storedAccount,
  storedAccountSummary,
} from "./rows";
import type { AccountWrite, PluginRepository } from "./types";

type AccountRowWrite = Omit<AccountWrite, "catalog">;

export function createAccountRows(sqlite: Database) {
  const selectAccount = sqlite.query<AccountRow, [string]>(
    `SELECT ${ACCOUNT_COLUMNS} FROM oauth_account WHERE provider_id = ?`,
  );
  function insertAccount(value: AccountRowWrite, revision: number, runtimeRevision: number, updatedAt: number): void {
    sqlite
      .query(
        `INSERT INTO oauth_account (
           provider_id, plugin, capability, fingerprint, options_json, secret_json, credential_json,
           revision, runtime_revision, label, expires_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.providerId,
        value.plugin,
        value.capability,
        value.fingerprint,
        encodeJson(value.options),
        encodeJson(value.secrets),
        encodeJson(value.credential),
        revision,
        runtimeRevision,
        value.label ?? null,
        value.expiresAt ?? null,
        updatedAt,
      );
  }
  function updateAccount(value: AccountRowWrite, revision: number, runtimeRevision: number, updatedAt: number): void {
    sqlite
      .query(
        `UPDATE oauth_account SET plugin = ?, capability = ?, fingerprint = ?, options_json = ?,
           secret_json = ?, credential_json = ?, revision = ?, runtime_revision = ?, label = ?, expires_at = ?,
           updated_at = ? WHERE provider_id = ?`,
      )
      .run(
        value.plugin,
        value.capability,
        value.fingerprint,
        encodeJson(value.options),
        encodeJson(value.secrets),
        encodeJson(value.credential),
        revision,
        runtimeRevision,
        value.label ?? null,
        value.expiresAt ?? null,
        updatedAt,
        value.providerId,
      );
  }
  return { selectAccount, insertAccount, updateAccount };
}

export function createAccountRepository(
  sqlite: Database,
): Pick<
  PluginRepository,
  "readAccount" | "findAccountByFingerprint" | "listAccounts" | "deleteAccount" | "compareAndSwapCredential"
> {
  const { selectAccount } = createAccountRows(sqlite);
  return {
    readAccount(providerId) {
      const row = selectAccount.get(providerId);
      return row === null ? null : storedAccount(row);
    },
    findAccountByFingerprint(plugin, capability, fingerprint) {
      const row = sqlite
        .query<AccountRow, [string, string, string]>(
          `SELECT ${ACCOUNT_COLUMNS} FROM oauth_account WHERE plugin = ? AND capability = ? AND fingerprint = ?`,
        )
        .get(plugin, capability, fingerprint);
      return row === null ? null : storedAccount(row);
    },
    listAccounts() {
      return sqlite
        .query<AccountSummaryRow, []>(`SELECT ${ACCOUNT_SUMMARY_COLUMNS} FROM oauth_account ORDER BY provider_id`)
        .all()
        .map(storedAccountSummary);
    },
    deleteAccount(providerId) {
      sqlite.query("DELETE FROM oauth_account WHERE provider_id = ?").run(providerId);
    },
    compareAndSwapCredential(providerId, expectedRevision, leaseOwner, credential, metadata) {
      const encoded = encodeJson(credential);
      return sqlite
        .transaction(() => {
          const current = selectAccount.get(providerId);
          if (current === null || current.revision !== expectedRevision) return null;
          const result = sqlite
            .query(
              `UPDATE oauth_account SET credential_json = ?, revision = revision + 1, label = ?, expires_at = ?,
               updated_at = ? WHERE provider_id = ? AND revision = ? AND EXISTS (
                 SELECT 1 FROM oauth_refresh_lease WHERE provider_id = ? AND owner = ? AND expires_at > ?
               )`,
            )
            .run(
              encoded,
              metadata?.label ?? current.label,
              metadata?.expiresAt ?? current.expires_at,
              Date.now(),
              providerId,
              expectedRevision,
              providerId,
              leaseOwner,
              Date.now(),
            );
          if (result.changes === 0) return null;
          const updated = selectAccount.get(providerId);
          return updated === null ? null : storedAccount(updated);
        })
        .immediate();
    },
  };
}
