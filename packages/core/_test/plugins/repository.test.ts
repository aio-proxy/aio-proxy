import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { Diagnostic, DiagnosticCode } from "@aio-proxy/types";
import { type OpenDbHandle, openDb } from "../../src/db";
import { type AccountWrite, createPluginRepository, type PluginRepository } from "../../src/plugins/repository";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function openRepository(): {
  readonly home: string;
  readonly handle: OpenDbHandle;
  readonly repository: PluginRepository;
} {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-repository-"));
  homes.push(home);
  const handle = openDb({ home });
  return { home, handle, repository: createPluginRepository(handle.sqlite) };
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

function refreshCredential(
  repository: PluginRepository,
  providerId: string,
  expectedRevision: number,
  credential: unknown,
  metadata?: { readonly label?: string; readonly expiresAt?: number },
) {
  const owner = crypto.randomUUID();
  const now = Date.now();
  if (!repository.tryAcquireRefreshLease(providerId, owner, now, now + 60_000)) throw new Error("lease unavailable");
  try {
    return repository.compareAndSwapCredential(providerId, expectedRevision, owner, credential, metadata);
  } finally {
    repository.releaseRefreshLease(providerId, owner);
  }
}

describe("plugin vault schema and opaque storage", () => {
  test("creates the vault tables without the legacy auth table", () => {
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
      expect(
        handle.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth'").get(),
      ).toBeNull();
    } finally {
      handle.close();
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
      const refreshed = refreshCredential(
        repository,
        "provider-1",
        1,
        { accessToken: "rotated" },
        {
          label: "Rotated",
          expiresAt: 999,
        },
      );
      expect(refreshed).toMatchObject({ revision: 2, runtimeRevision: 1, label: "Rotated", expiresAt: 999 });
      expect(refreshCredential(repository, "provider-1", 1, { accessToken: "stale" })).toBeNull();

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

      refreshCredential(repository, "provider-1", 1, { accessToken: "latest-before-update" });
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
        refreshCredential(repository, "provider-1", pending.appliedRevision, { accessToken: "newer" }),
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
      refreshCredential(repository, "provider-1", 1, { accessToken: "rotated" });
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

  test("blocks recreation while a delete is pending and prevents its old marker from deleting a recreated id", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const pending = repository.stageAccountOperation({
        kind: "delete",
        targetDigest: "absent",
        providerId: "provider-1",
        expectedRuntimeRevision: 1,
      });
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

  test("a later delete atomically supersedes the stale delete marker", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      const first = repository.stageAccountOperation({
        kind: "delete",
        targetDigest: "absent",
        providerId: "provider-1",
        expectedRuntimeRevision: 1,
      });
      const second = repository.stageAccountOperation({
        kind: "delete",
        targetDigest: "absent",
        providerId: "provider-1",
        expectedRuntimeRevision: 1,
      });

      expect(second.operationId).not.toBe(first.operationId);
      expect(repository.finalizeDeleteOperation(first.operationId)).toBe("superseded");
      expect(repository.listPendingAccountOperations()).toEqual([second]);
      expect(repository.finalizeDeleteOperation(second.operationId)).toBe("deleted");
      expect(repository.readAccount("provider-1")).toBeNull();
    } finally {
      handle.close();
    }
  });

  test("reports an incompatible pending operation as a named conflict", () => {
    const { handle, repository } = openRepository();
    try {
      createAccount(repository);
      repository.stageAccountOperation({
        kind: "update",
        targetDigest: "digest:update",
        expectedRuntimeRevision: 1,
        account: account("provider-1", { options: { generation: 2 } }),
      });

      expect(() =>
        repository.stageAccountOperation({
          kind: "delete",
          targetDigest: "absent",
          providerId: "provider-1",
          expectedRuntimeRevision: 2,
        }),
      ).toThrow(
        expect.objectContaining({
          name: "PendingAccountOperationConflictError",
          providerId: "provider-1",
        }),
      );
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

  test("staged update clears credential failure and compensation restores it when no newer child data exists", () => {
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
      expect(repository.readDiagnostics("provider-1")).not.toContainEqual(diagnostic("CREDENTIAL_REFRESH_FAILED"));

      expect(repository.compensateAccountOperation(pending.operationId)).toBe("compensated");
      expect(repository.readAccount("provider-1")).toMatchObject({ options: { tenant: "public" }, revision: 1 });
      expect(repository.readDiagnostics("provider-1")).toContainEqual(diagnostic("CREDENTIAL_REFRESH_FAILED"));
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

  test("corrupt plugin secret JSON is reported instead of treated as absent", () => {
    const { handle, repository } = openRepository();
    try {
      handle.sqlite
        .query("INSERT INTO plugin_secret (plugin, value_json, revision, updated_at) VALUES (?, ?, 1, ?)")
        .run("@aio-proxy/corrupt", "{", Date.now());

      expect(() => repository.readPluginSecret("@aio-proxy/corrupt")).toThrow(SyntaxError);
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

  test("credential CAS rejects a stale owner after another database handle takes over its expired lease", () => {
    const { home, handle, repository } = openRepository();
    const secondHandle = openDb({ home });
    const second = createPluginRepository(secondHandle.sqlite);
    try {
      createAccount(repository);
      expect(repository.tryAcquireRefreshLease("provider-1", "owner-a", 100, 200)).toBe(true);
      expect(second.tryAcquireRefreshLease("provider-1", "owner-b", 201, Number.MAX_SAFE_INTEGER)).toBe(true);

      expect(
        repository.compareAndSwapCredential("provider-1", 1, "owner-a", { accessToken: "stale-owner" }),
      ).toBeNull();
      expect(
        second.compareAndSwapCredential("provider-1", 1, "owner-b", { accessToken: "winning-owner" }),
      ).toMatchObject({ revision: 2, credential: { accessToken: "winning-owner" } });
    } finally {
      secondHandle.close();
      handle.close();
    }
  });
});
