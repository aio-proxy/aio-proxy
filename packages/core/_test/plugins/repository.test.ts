import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { Diagnostic, DiagnosticCode } from "@aio-proxy/types";
import { type OpenDbHandle, openDb } from "../../src/db";
import { MIGRATIONS } from "../../src/db/migrations.manifest";
import { type AccountWrite, createPluginRepository, type PluginRepository } from "../../src/plugins/repository";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function openRepository(): { readonly handle: OpenDbHandle; readonly repository: PluginRepository } {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-repository-"));
  homes.push(home);
  const handle = openDb({ home });
  return { handle, repository: createPluginRepository(handle.sqlite) };
}

function catalog(id = "model-1"): ModelCatalog {
  return {
    language: [{ id }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function diagnostic(code: DiagnosticCode, summary = code): Diagnostic {
  return { code, summary, retryable: true, occurredAt: "2026-07-14T00:00:00.000Z" };
}

function account(providerId: string, overrides: Partial<AccountWrite> = {}): AccountWrite {
  return {
    providerId,
    plugin: "@aio-proxy/example",
    capability: "oauth",
    fingerprint: `${providerId}-fingerprint`,
    options: { tenant: "public", nested: [1, true, null] },
    secrets: { clientSecret: "account-secret" },
    credential: { accessToken: "credential-secret", refreshToken: "refresh-secret" },
    label: "Example account",
    expiresAt: 123_456,
    catalog: { kind: "replace", value: { catalog: catalog(), refreshedAt: 100 } },
    ...overrides,
  };
}

function createAccount(repository: PluginRepository, value: AccountWrite = account("provider-1")): void {
  const pending = repository.stageAccountOperation({ kind: "create", targetDigest: "digest:create", account: value });
  repository.completeAccountOperation(pending.operationId);
}

describe("plugin vault schema and opaque storage", () => {
  test("creates the vault tables with the expected revision columns while preserving legacy auth", () => {
    const { handle } = openRepository();
    try {
      const columns = handle.sqlite.query("PRAGMA table_info(oauth_account)").all() as Array<{ name: string }>;
      expect(columns.map(({ name }) => name)).toEqual([
        "provider_id",
        "plugin",
        "capability",
        "fingerprint",
        "options_json",
        "secret_json",
        "credential_json",
        "revision",
        "runtime_revision",
        "label",
        "expires_at",
        "updated_at",
      ]);

      handle.sqlite
        .query(
          "INSERT INTO auth (vendor, provider_id, account_fingerprint, payload, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run("legacy", "old-provider", "old-fingerprint", '{"token":"still-readable"}', 1);
      expect(handle.sqlite.query("SELECT payload FROM auth WHERE vendor = ?").get("legacy")).toEqual({
        payload: '{"token":"still-readable"}',
      });
    } finally {
      handle.close();
    }
  });

  test("upgrades a populated pre-0004 database without losing legacy auth, request, or usage rows", () => {
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-repository-upgrade-"));
    homes.push(home);
    const path = join(home, "aio-proxy.db");
    const legacy = new Database(path);
    const migrationsThrough0003 = MIGRATIONS.filter(({ file }) => file <= "0003_request_log_indexes.sql");
    const migrate = legacy.transaction(() => {
      for (const migration of migrationsThrough0003) legacy.exec(migration.sql);
      legacy.exec(`PRAGMA user_version = ${migrationsThrough0003.at(-1)?.version ?? 0}`);
    });
    migrate.immediate();
    legacy
      .query("INSERT INTO auth (vendor, provider_id, account_fingerprint, payload, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("legacy", "legacy-provider", "legacy-fingerprint", '{"token":"retained"}', 10);
    legacy
      .query(
        `INSERT INTO request_log (
           request_id, inbound_protocol, requested_model_id, outcome, final_provider_id, final_model_id,
           attempts_json, started_at, completed_at, duration_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "request-before-0004",
        "legacy",
        "model-before-0004",
        "success",
        "legacy-provider",
        "model-before-0004",
        "[]",
        10,
        11,
        1,
      );
    legacy
      .query(
        `INSERT INTO usage (
           id, request_id, provider_id, model_id, input_tokens, output_tokens, total_tokens, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("usage-before-0004", "request-before-0004", "legacy-provider", "model-before-0004", 1, 2, 3, 11);
    legacy.close();

    const upgraded = openDb({ home });
    try {
      expect(upgraded.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: MIGRATIONS.length });
      expect(upgraded.sqlite.query("SELECT payload FROM auth WHERE provider_id = ?").get("legacy-provider")).toEqual({
        payload: '{"token":"retained"}',
      });
      expect(
        upgraded.sqlite
          .query("SELECT requested_model_id FROM request_log WHERE request_id = ?")
          .get("request-before-0004"),
      ).toEqual({
        requested_model_id: "model-before-0004",
      });
      expect(upgraded.sqlite.query("SELECT total_tokens FROM usage WHERE id = ?").get("usage-before-0004")).toEqual({
        total_tokens: 3,
      });
      expect(upgraded.sqlite.query("PRAGMA table_info(oauth_account)").all()).not.toHaveLength(0);
    } finally {
      upgraded.close();
    }
  });

  test("round-trips opaque account JSON without exposing it in list summaries", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      expect(repository.readAccount("provider-1")).toMatchObject({
        options: { tenant: "public", nested: [1, true, null] },
        secrets: { clientSecret: "account-secret" },
        credential: { accessToken: "credential-secret", refreshToken: "refresh-secret" },
        revision: 1,
        runtimeRevision: 1,
      });

      const [summary] = repository.listAccounts();
      expect(summary).toMatchObject({ providerId: "provider-1", revision: 1, runtimeRevision: 1 });
      expect(summary).not.toHaveProperty("options");
      expect(summary).not.toHaveProperty("secrets");
      expect(summary).not.toHaveProperty("credential");
      expect(JSON.stringify(summary)).not.toContain("account-secret");
      expect(JSON.stringify(summary)).not.toContain("credential-secret");
    } finally {
      handle.close();
    }
  });

  test("enforces unique plugin capability fingerprints", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      expect(() =>
        repository.stageAccountOperation({
          kind: "create",
          targetDigest: "digest:duplicate",
          account: account("provider-2", { fingerprint: "provider-1-fingerprint" }),
        }),
      ).toThrow();
      expect(repository.readAccount("provider-2")).toBeNull();
    } finally {
      handle.close();
    }
  });
});

describe("independent credential and runtime revisions", () => {
  test("refresh changes only credential revision and does not make re-login stale", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const refreshed = repository.compareAndSwapCredential(
        "provider-1",
        1,
        { accessToken: "rotated" },
        {
          label: "Rotated",
          expiresAt: 999,
        },
      );
      expect(refreshed).toMatchObject({ revision: 2, runtimeRevision: 1, label: "Rotated", expiresAt: 999 });
      expect(repository.compareAndSwapCredential("provider-1", 1, { accessToken: "stale" })).toBeNull();

      const pending = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:relogin",
        expectedRuntimeRevision: 1,
        account: account("provider-1", {
          options: { tenant: "changed" },
          credential: { accessToken: "re-login" },
        }),
      });
      expect(pending).toMatchObject({ appliedRevision: 3, previousRevision: 2 });
      expect(repository.readAccount("provider-1")).toMatchObject({ revision: 3, runtimeRevision: 2 });
      repository.completeAccountOperation(pending.operationId);
    } finally {
      handle.close();
    }
  });

  test("a concurrent re-login or options update makes an older runtime revision stale", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const first = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:first",
        expectedRuntimeRevision: 1,
        account: account("provider-1", { options: { generation: 2 } }),
      });
      repository.completeAccountOperation(first.operationId);
      expect(() =>
        repository.stageAccountOperation({
          kind: "update",
          targetDigest: "digest:stale",
          expectedRuntimeRevision: 1,
          account: account("provider-1", { options: { generation: 3 } }),
        }),
      ).toThrow();
      expect(repository.readAccount("provider-1")).toMatchObject({ options: { generation: 2 }, runtimeRevision: 2 });
    } finally {
      handle.close();
    }
  });
});

describe("pending operation compensation", () => {
  test("create and update pending rows retain rollback state and use credential revision as appliedRevision", () => {
    const { handle, repository } = openRepository();
    try {
      const created = repository.stageAccountOperation({
        kind: "create",
        targetDigest: "digest:create",
        account: account("provider-1"),
      });
      expect(created).toMatchObject({ kind: "create", appliedRevision: 1 });
      expect(created.previousRevision).toBeUndefined();
      repository.completeAccountOperation(created.operationId);

      repository.compareAndSwapCredential("provider-1", 1, { accessToken: "latest-before-update" });
      const updated = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:update",
        expectedRuntimeRevision: 1,
        account: account("provider-1", {
          credential: { accessToken: "replacement" },
          catalog: { kind: "replace", value: { catalog: catalog("model-2"), refreshedAt: 200 } },
        }),
      });
      expect(updated).toMatchObject({ kind: "update", appliedRevision: 3, previousRevision: 2 });
      const raw = handle.sqlite
        .query("SELECT rollback_json FROM oauth_pending_operation WHERE operation_id = ?")
        .get(updated.operationId) as { rollback_json: string | null };
      expect(JSON.parse(raw.rollback_json ?? "null")).toMatchObject({
        previous: {
          revision: 2,
          runtimeRevision: 1,
          credential: { accessToken: "latest-before-update" },
          catalog: { catalog: catalog(), refreshedAt: 100 },
        },
        applied: {
          catalog: { catalog: catalog("model-2"), refreshedAt: 200 },
          diagnostics: [],
        },
      });
      expect(repository.compensateAccountOperation(updated.operationId)).toBe("compensated");
      expect(repository.readAccount("provider-1")).toMatchObject({
        revision: 2,
        runtimeRevision: 1,
        credential: { accessToken: "latest-before-update" },
      });
    } finally {
      handle.close();
    }
  });

  test("compensation refuses to overwrite a concurrent credential refresh", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const pending = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:update",
        expectedRuntimeRevision: 1,
        account: account("provider-1", { credential: { accessToken: "replacement" } }),
      });
      expect(
        repository.compareAndSwapCredential("provider-1", pending.appliedRevision, { accessToken: "newer" }),
      ).toMatchObject({
        revision: 3,
        runtimeRevision: 2,
      });
      expect(repository.compensateAccountOperation(pending.operationId)).toBe("superseded");
      expect(repository.readAccount("provider-1")).toMatchObject({ credential: { accessToken: "newer" }, revision: 3 });
      expect(repository.listPendingAccountOperations()).toHaveLength(0);
    } finally {
      handle.close();
    }
  });

  test("delete uses pre-delete runtime revision while blocking replacement until its marker is cleared", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const refreshTolerant = repository.stageAccountOperation({
        kind: "delete",
        targetDigest: "absent",
        providerId: "provider-1",
        expectedRuntimeRevision: 1,
      });
      expect(refreshTolerant).toMatchObject({ kind: "delete", appliedRevision: 1, previousRevision: 1 });
      repository.compareAndSwapCredential("provider-1", 1, { accessToken: "rotated" });
      expect(repository.finalizeDeleteOperation(refreshTolerant.operationId)).toBe("deleted");
      expect(repository.readAccount("provider-1")).toBeNull();

      createAccount(repository);
      const superseded = repository.stageAccountOperation({
        kind: "delete",
        targetDigest: "absent",
        providerId: "provider-1",
        expectedRuntimeRevision: 1,
      });
      expect(() =>
        repository.stageAccountOperation({
          kind: "update",
          targetDigest: "digest:replacement-too-early",
          expectedRuntimeRevision: 1,
          account: account("provider-1", { options: { generation: 2 } }),
        }),
      ).toThrow();
      expect(repository.compensateAccountOperation(superseded.operationId)).toBe("compensated");
      const replacement = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:replacement",
        expectedRuntimeRevision: 1,
        account: account("provider-1", { options: { generation: 2 } }),
      });
      repository.completeAccountOperation(replacement.operationId);
      expect(repository.finalizeDeleteOperation(superseded.operationId)).toBe("superseded");
      expect(repository.readAccount("provider-1")).toMatchObject({ runtimeRevision: 2 });
    } finally {
      handle.close();
    }
  });

  test("blocks multiple pending deletes and prevents an old delete marker from deleting a recreated provider id", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const pending = repository.stageAccountOperation({
        kind: "delete",
        targetDigest: "absent",
        providerId: "provider-1",
        expectedRuntimeRevision: 1,
      });
      expect(() =>
        repository.stageAccountOperation({
          kind: "delete",
          targetDigest: "absent",
          providerId: "provider-1",
          expectedRuntimeRevision: 1,
        }),
      ).toThrow();

      repository.deleteAccount("provider-1");
      expect(() =>
        repository.stageAccountOperation({
          kind: "create",
          targetDigest: "digest:recreate-too-early",
          account: account("provider-1", { credential: { accessToken: "new-incarnation" } }),
        }),
      ).toThrow();
      expect(repository.finalizeDeleteOperation(pending.operationId)).toBe("superseded");

      const recreated = repository.stageAccountOperation({
        kind: "create",
        targetDigest: "digest:recreate",
        account: account("provider-1", { credential: { accessToken: "new-incarnation" } }),
      });
      repository.completeAccountOperation(recreated.operationId);
      expect(repository.finalizeDeleteOperation(pending.operationId)).toBe("superseded");
      expect(repository.readAccount("provider-1")).toMatchObject({ credential: { accessToken: "new-incarnation" } });
    } finally {
      handle.close();
    }
  });

  test("catalog refresh after a staged update makes compensation superseded without overwriting it", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const pending = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:update",
        expectedRuntimeRevision: 1,
        account: account("provider-1", {
          options: { generation: 2 },
          catalog: { kind: "replace", value: { catalog: catalog("model-2"), refreshedAt: 200 } },
        }),
      });
      repository.writeCatalog("provider-1", catalog("model-3"), 300);

      expect(repository.compensateAccountOperation(pending.operationId)).toBe("superseded");
      expect(repository.readAccount("provider-1")).toMatchObject({ options: { generation: 2 }, revision: 2 });
      expect(repository.readCatalog("provider-1")).toEqual({ catalog: catalog("model-3"), refreshedAt: 300 });
    } finally {
      handle.close();
    }
  });

  test("diagnostic write after a staged update makes compensation superseded without clearing it", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const pending = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:update",
        expectedRuntimeRevision: 1,
        account: account("provider-1", { options: { generation: 2 } }),
      });
      const later = diagnostic("CREDENTIAL_REFRESH_FAILED", "later diagnostic");
      repository.writeDiagnostic("provider-1", later);

      expect(repository.compensateAccountOperation(pending.operationId)).toBe("superseded");
      expect(repository.readAccount("provider-1")).toMatchObject({ options: { generation: 2 }, revision: 2 });
      expect(repository.readDiagnostics("provider-1")).toContainEqual(later);
    } finally {
      handle.close();
    }
  });

  test("changed same-code diagnostic after a staged update makes compensation superseded", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      repository.writeDiagnostic("provider-1", diagnostic("CREDENTIAL_REFRESH_FAILED", "before update"));
      const pending = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:update",
        expectedRuntimeRevision: 1,
        account: account("provider-1", { options: { generation: 2 } }),
      });
      const changed = diagnostic("CREDENTIAL_REFRESH_FAILED", "after update");

      expect(repository.writeDiagnostic("provider-1", changed)).toBe(true);
      expect(repository.compensateAccountOperation(pending.operationId)).toBe("superseded");
      expect(repository.readDiagnostics("provider-1")).toContainEqual(changed);
    } finally {
      handle.close();
    }
  });

  test("diagnostic clear after a staged update makes compensation superseded without restoring it", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      repository.writeDiagnostic("provider-1", diagnostic("CREDENTIAL_REFRESH_FAILED"));
      const pending = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:update",
        expectedRuntimeRevision: 1,
        account: account("provider-1", { options: { generation: 2 } }),
      });
      repository.clearDiagnostic("provider-1", "CREDENTIAL_REFRESH_FAILED");

      expect(repository.compensateAccountOperation(pending.operationId)).toBe("superseded");
      expect(repository.readAccount("provider-1")).toMatchObject({ options: { generation: 2 }, revision: 2 });
      expect(repository.readDiagnostics("provider-1")).not.toContainEqual(diagnostic("CREDENTIAL_REFRESH_FAILED"));
    } finally {
      handle.close();
    }
  });
});

describe("catalogs, diagnostics, plugin secrets, and refresh leases", () => {
  test("identical diagnostics are no-ops while changed same-code diagnostics replace the stored value", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const first = diagnostic("CREDENTIAL_REFRESH_FAILED", "first");
      const changed = diagnostic("CREDENTIAL_REFRESH_FAILED", "changed");

      expect(repository.writeDiagnostic("provider-1", first)).toBe(true);
      expect(repository.writeDiagnostic("provider-1", first)).toBe(false);
      expect(repository.writeDiagnostic("provider-1", changed)).toBe(true);
      expect(repository.readDiagnostics("provider-1")).toEqual([changed]);
    } finally {
      handle.close();
    }
  });

  test("account deletion cascades catalog, lease, and diagnostics", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      repository.writeDiagnostic("provider-1", diagnostic("CREDENTIAL_REFRESH_FAILED"));
      expect(repository.tryAcquireRefreshLease("provider-1", "worker-1", 100, 200)).toBe(true);
      repository.deleteAccount("provider-1");
      for (const table of ["oauth_catalog", "oauth_account_diagnostic", "oauth_refresh_lease"]) {
        expect(handle.sqlite.query(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      handle.close();
    }
  });

  test("credential and catalog diagnostics coexist by code and clear independently", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(
        repository,
        account("provider-1", {
          catalog: { kind: "missing", diagnostic: diagnostic("CATALOG_UNAVAILABLE") },
        }),
      );
      expect(repository.writeDiagnostic("provider-1", diagnostic("CREDENTIALS_MISSING_OR_INVALID"))).toBe(true);
      expect(
        repository
          .readDiagnostics("provider-1")
          .map(({ code }) => code)
          .sort(),
      ).toEqual(["CATALOG_UNAVAILABLE", "CREDENTIALS_MISSING_OR_INVALID"]);
      expect(repository.clearDiagnostic("provider-1", "CATALOG_UNAVAILABLE")).toBe(true);
      expect(repository.readDiagnostics("provider-1").map(({ code }) => code)).toEqual([
        "CREDENTIALS_MISSING_OR_INVALID",
      ]);
    } finally {
      handle.close();
    }
  });

  test("catalog preserve keeps an existing catalog while recording its diagnostic", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const pending = repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:preserve",
        expectedRuntimeRevision: 1,
        account: account("provider-1", {
          catalog: { kind: "preserve", diagnostic: diagnostic("CATALOG_UNAVAILABLE") },
        }),
      });
      repository.completeAccountOperation(pending.operationId);
      expect(repository.readCatalog("provider-1")).toEqual({ catalog: catalog(), refreshedAt: 100 });
      expect(repository.readDiagnostics("provider-1")).toContainEqual(diagnostic("CATALOG_UNAVAILABLE"));
    } finally {
      handle.close();
    }
  });

  test("revision-conditional plugin secret deletion refuses concurrent updates and never deletes accounts", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      expect(repository.writePluginSecret("@aio-proxy/example", null, { clientSecret: "one" })).toEqual({
        value: { clientSecret: "one" },
        revision: 1,
      });
      expect(repository.writePluginSecret("@aio-proxy/example", 1, { clientSecret: "two" })).toEqual({
        value: { clientSecret: "two" },
        revision: 2,
      });
      expect(repository.deletePluginSecret("@aio-proxy/example", 1)).toBe(false);
      expect(repository.readPluginSecret("@aio-proxy/example")).toEqual({
        value: { clientSecret: "two" },
        revision: 2,
      });
      expect(repository.deletePluginSecret("@aio-proxy/example", 2)).toBe(true);
      expect(repository.readAccount("provider-1")).not.toBeNull();
    } finally {
      handle.close();
    }
  });

  test("refresh lease acquisition, renewal, expiry takeover, and owner release are conditional", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      expect(repository.tryAcquireRefreshLease("provider-1", "worker-1", 100, 200)).toBe(true);
      expect(repository.tryAcquireRefreshLease("provider-1", "worker-2", 150, 250)).toBe(false);
      expect(repository.renewRefreshLease("provider-1", "worker-2", 300)).toBe(false);
      expect(repository.renewRefreshLease("provider-1", "worker-1", 300)).toBe(true);
      expect(repository.tryAcquireRefreshLease("provider-1", "worker-2", 301, 400)).toBe(true);
      repository.releaseRefreshLease("provider-1", "worker-1");
      expect(repository.tryAcquireRefreshLease("provider-1", "worker-3", 302, 450)).toBe(false);
      repository.releaseRefreshLease("provider-1", "worker-2");
      expect(repository.tryAcquireRefreshLease("provider-1", "worker-3", 302, 450)).toBe(true);
    } finally {
      handle.close();
    }
  });
});
