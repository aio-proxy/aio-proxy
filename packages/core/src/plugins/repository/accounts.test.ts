import { account, createAccount, expect, openRepository, refreshCredential, test } from "./test-support";

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
