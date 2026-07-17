import {
  ABSENT_PROVIDER_DIGEST,
  configOf,
  createAccount,
  deleteOAuthAccount,
  digestProviderEntry,
  emptyCatalog,
  expect,
  fixture,
  ORPHAN_ACCOUNT_GRACE_MS,
  PENDING_OPERATION_TTL_MS,
  RECOVERY_DRAIN_RETRY_MS,
  recoverPendingAccountOperations,
  refreshCredential,
  test,
} from "./test-support";

test("delete stages runtimeRevision and server recovery drains before final deletion", async () => {
  const state = fixture();
  await createAccount(state);
  const marker = await deleteOAuthAccount({
    providerId: "person",
    config: state.config,
    repository: state.repository,
  });
  expect(marker).toMatchObject({ kind: "delete", targetDigest: ABSENT_PROVIDER_DIGEST, appliedRevision: 1 });
  expect((configOf(state)["providers"] as Record<string, unknown>)["person"]).toBeUndefined();
  state.sqlite
    .query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?")
    .run(marker.operationId);
  const blocked = await recoverPendingAccountOperations(state.config, state.repository, {
    mode: "server",
    canDeleteAccount: () => false,
    now: () => PENDING_OPERATION_TTL_MS + 1,
  });
  expect(blocked.nextRunAt).toBe(PENDING_OPERATION_TTL_MS + 1 + RECOVERY_DRAIN_RETRY_MS);
  expect(state.repository.readAccount("person")).not.toBeNull();
  await recoverPendingAccountOperations(state.config, state.repository, {
    mode: "server",
    canDeleteAccount: () => true,
    now: () => PENDING_OPERATION_TTL_MS + RECOVERY_DRAIN_RETRY_MS + 2,
  });
  expect(state.repository.readAccount("person")).toBeNull();
});

test("credential refresh does not block delete, while provider re-add or runtime replacement supersedes it", async () => {
  const refreshed = fixture();
  await createAccount(refreshed);
  const marker = await deleteOAuthAccount({
    providerId: "person",
    config: refreshed.config,
    repository: refreshed.repository,
  });
  refreshCredential(refreshed, 1, { token: "refresh" });
  refreshed.sqlite
    .query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?")
    .run(marker.operationId);
  await recoverPendingAccountOperations(refreshed.config, refreshed.repository, {
    mode: "server",
    canDeleteAccount: () => true,
    now: () => PENDING_OPERATION_TTL_MS + 1,
  });
  expect(refreshed.repository.readAccount("person")).toBeNull();

  const readded = fixture();
  await createAccount(readded);
  const readdedMarker = await deleteOAuthAccount({
    providerId: "person",
    config: readded.config,
    repository: readded.repository,
  });
  await readded.config.replace((current) => ({
    ...current,
    providers: { person: { kind: "oauth", plugin: "@example/oauth", capability: "default", enabled: true } },
  }));
  readded.sqlite
    .query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?")
    .run(readdedMarker.operationId);
  await recoverPendingAccountOperations(readded.config, readded.repository, {
    mode: "server",
    canDeleteAccount: () => true,
    now: () => PENDING_OPERATION_TTL_MS + 1,
  });
  expect(readded.repository.readAccount("person")).not.toBeNull();
  expect(readded.repository.listPendingAccountOperations()).toHaveLength(0);

  const replaced = fixture();
  await createAccount(replaced);
  const replacedMarker = await deleteOAuthAccount({
    providerId: "person",
    config: replaced.config,
    repository: replaced.repository,
  });
  replaced.sqlite
    .query("UPDATE oauth_account SET runtime_revision = runtime_revision + 1 WHERE provider_id = 'person'")
    .run();
  replaced.sqlite
    .query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?")
    .run(replacedMarker.operationId);
  await recoverPendingAccountOperations(replaced.config, replaced.repository, {
    mode: "server",
    canDeleteAccount: () => true,
    now: () => PENDING_OPERATION_TTL_MS + 1,
  });
  expect(replaced.repository.readAccount("person")?.runtimeRevision).toBe(2);
  expect(replaced.repository.listPendingAccountOperations()).toHaveLength(0);
});

test("expired create marker completes on matching digest and compensates on a different digest", async () => {
  const matching = fixture();
  const provider = { kind: "oauth", plugin: "@example/oauth", capability: "default", enabled: true };
  await matching.config.replace((current) => ({ ...current, providers: { person: provider } }));
  const op = matching.repository.stageAccountOperation({
    kind: "create",
    targetDigest: digestProviderEntry(provider),
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "f",
      options: {},
      secrets: {},
      credential: { token: "x" },
      catalog: { kind: "replace", value: { catalog: emptyCatalog(), refreshedAt: 0 } },
    },
  });
  matching.sqlite.query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?").run(op.operationId);
  await recoverPendingAccountOperations(matching.config, matching.repository, {
    mode: "cli",
    now: () => PENDING_OPERATION_TTL_MS + 1,
  });
  expect(matching.repository.readAccount("person")).not.toBeNull();
  expect(matching.repository.listPendingAccountOperations()).toHaveLength(0);

  const different = fixture();
  const stale = different.repository.stageAccountOperation({
    kind: "create",
    targetDigest: "wrong",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "f",
      options: {},
      secrets: {},
      credential: { token: "x" },
      catalog: { kind: "replace", value: { catalog: emptyCatalog(), refreshedAt: 0 } },
    },
  });
  different.sqlite
    .query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?")
    .run(stale.operationId);
  await recoverPendingAccountOperations(different.config, different.repository, {
    mode: "cli",
    now: () => PENDING_OPERATION_TTL_MS + 1,
  });
  expect(different.repository.readAccount("person")).toBeNull();
});

test("non-expired markers are untouched and report their TTL deadline", async () => {
  const state = fixture();
  const op = state.repository.stageAccountOperation({
    kind: "create",
    targetDigest: "digest",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "f",
      options: {},
      secrets: {},
      credential: { token: "x" },
      catalog: { kind: "replace", value: { catalog: emptyCatalog(), refreshedAt: 0 } },
    },
  });
  state.sqlite.query("UPDATE oauth_pending_operation SET created_at = 100 WHERE operation_id = ?").run(op.operationId);
  const result = await recoverPendingAccountOperations(state.config, state.repository, {
    mode: "cli",
    now: () => 200,
  });
  expect(result.nextRunAt).toBe(100 + PENDING_OPERATION_TTL_MS);
  expect(state.repository.listPendingAccountOperations()).toHaveLength(1);
});

test("CLI leaves delete/orphan rows while server applies orphan grace and drain gating", async () => {
  const state = fixture();
  await createAccount(state);
  await state.config.replace((current) => ({ ...current, providers: {} }));
  state.sqlite.query("UPDATE oauth_account SET updated_at = 100 WHERE provider_id = 'person'").run();
  const cli = await recoverPendingAccountOperations(state.config, state.repository, { mode: "cli", now: () => 200 });
  expect(cli.nextRunAt).toBe(100 + ORPHAN_ACCOUNT_GRACE_MS);
  expect(state.repository.readAccount("person")).not.toBeNull();
  const blocked = await recoverPendingAccountOperations(state.config, state.repository, {
    mode: "server",
    canDeleteAccount: () => false,
    now: () => ORPHAN_ACCOUNT_GRACE_MS + 101,
  });
  expect(blocked.nextRunAt).toBe(ORPHAN_ACCOUNT_GRACE_MS + 101 + RECOVERY_DRAIN_RETRY_MS);
  expect(state.repository.readAccount("person")).not.toBeNull();
  await recoverPendingAccountOperations(state.config, state.repository, {
    mode: "server",
    canDeleteAccount: () => true,
    now: () => ORPHAN_ACCOUNT_GRACE_MS + RECOVERY_DRAIN_RETRY_MS + 102,
  });
  expect(state.repository.readAccount("person")).toBeNull();
});

test("recovery preserves accounts and schedules a bounded retry for malformed providers config", async () => {
  const state = fixture({ plugins: [], providers: "malformed" });
  const operation = state.repository.stageAccountOperation({
    kind: "create",
    targetDigest: "unused",
    account: {
      providerId: "orphan",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "orphan",
      options: {},
      secrets: {},
      credential: { token: "x" },
      catalog: { kind: "replace", value: { catalog: emptyCatalog(), refreshedAt: 0 } },
    },
  });
  state.repository.completeAccountOperation(operation.operationId);
  state.sqlite.query("UPDATE oauth_account SET updated_at = 0 WHERE provider_id = 'orphan'").run();
  const now = ORPHAN_ACCOUNT_GRACE_MS + 1;
  const result = await recoverPendingAccountOperations(state.config, state.repository, {
    mode: "server",
    canDeleteAccount: () => true,
    now: () => now,
  });
  expect(result.nextRunAt).toBe(now + RECOVERY_DRAIN_RETRY_MS);
  expect(state.repository.readAccount("orphan")).not.toBeNull();
  expect(configOf(state)).toEqual({ plugins: [], providers: "malformed" });
});

test("orphan cleanup preserves referenced, young, and pending accounts", async () => {
  const state = fixture();
  await createAccount(state);
  state.sqlite.query("UPDATE oauth_account SET updated_at = 0 WHERE provider_id = 'person'").run();
  state.repository.stageAccountOperation({
    kind: "create",
    targetDigest: "pending",
    account: {
      providerId: "pending",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "pending",
      options: {},
      secrets: {},
      credential: { token: "pending" },
      catalog: { kind: "replace", value: { catalog: emptyCatalog(), refreshedAt: 0 } },
    },
  });
  state.sqlite.query("UPDATE oauth_account SET updated_at = 0 WHERE provider_id = 'pending'").run();
  await recoverPendingAccountOperations(state.config, state.repository, {
    mode: "server",
    canDeleteAccount: () => true,
    now: () => ORPHAN_ACCOUNT_GRACE_MS + 1,
  });
  expect(state.repository.readAccount("person")).not.toBeNull();
  expect(state.repository.readAccount("pending")).not.toBeNull();
});
