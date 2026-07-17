import {
  account,
  catalog,
  createAccount,
  createPluginRepository,
  diagnostic,
  expect,
  openDb,
  openRepository,
  test,
} from "./test-support";

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

    expect(repository.compareAndSwapCredential("provider-1", 1, "owner-a", { accessToken: "stale-owner" })).toBeNull();
    expect(second.compareAndSwapCredential("provider-1", 1, "owner-b", { accessToken: "winning-owner" })).toMatchObject(
      { revision: 2, credential: { accessToken: "winning-owner" } },
    );
  } finally {
    secondHandle.close();
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
