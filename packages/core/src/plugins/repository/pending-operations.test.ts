import {
  account,
  catalog,
  createAccount,
  diagnostic,
  expect,
  openRepository,
  refreshCredential,
  test,
} from "./test-support";

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
