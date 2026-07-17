import {
  AtomicConfigCommitUncertainError,
  type AtomicConfigFile,
  accountOf,
  configOf,
  createAccount,
  diagnostics,
  emptyCatalog,
  expect,
  fixture,
  loginOAuthAccount,
  options,
  PENDING_OPERATION_TTL_MS,
  type PluginLogSink,
  recoverPendingAccountOperations,
  refreshCredential,
  registry,
  test,
} from "./test-support";

test("two concurrent creates recheck fingerprint under the config lock and preserve unrelated edits", async () => {
  const state = fixture();
  let releases = 0;
  let resolveBoth!: () => void;
  const gate = new Promise<void>((resolve) => {
    resolveBoth = resolve;
  });
  const adapter = registry({
    login: async () => {
      releases += 1;
      await gate;
      return { fingerprint: "same", suggestedKey: "same", credentials: { token: "x" } };
    },
  });
  const first = createAccount(state, { registry: adapter });
  const second = createAccount(state, { registry: adapter });
  while (releases < 2) await Bun.sleep(1);
  await state.config.replace((current) => ({
    ...current,
    providers: {
      ...(current["providers"] as object),
      unrelated: { kind: "api", protocol: "openai-compatible", baseURL: "https://example.com" },
    },
  }));
  resolveBoth();
  const outcomes = await Promise.allSettled([first, second]);
  expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter((item) => item.status === "rejected")[0]).toMatchObject({
    reason: { name: "ProviderAccountAlreadyExistsError" },
  });
  expect(state.repository.listAccounts()).toHaveLength(1);
  expect((configOf(state)["providers"] as Record<string, unknown>)["unrelated"]).toBeDefined();
});

test("config validation failure conditionally deletes a create and restores an update", async () => {
  const createState = fixture({ plugins: [42], providers: {} });
  await expect(createAccount(createState)).rejects.toBeDefined();
  expect(createState.repository.listAccounts()).toHaveLength(0);

  const updateState = fixture();
  await createAccount(updateState);
  await updateState.config.replace((current) => ({
    ...current,
    plugins: [42],
  }));
  await expect(
    loginOAuthAccount(options(updateState, { targetProviderId: "person", capability: undefined })),
  ).rejects.toBeDefined();
  expect(updateState.repository.readAccount("person")).toMatchObject({
    revision: 1,
    runtimeRevision: 1,
    options: { tenant: "work" },
  });
});

test("definite config write failure removes a newly staged account", async () => {
  const state = fixture();
  const real = state.config;
  const failing = {
    async transaction<T>(mutate: Parameters<AtomicConfigFile["transaction"]>[0]): Promise<T> {
      await mutate(await real.read());
      throw new Error("write failed");
    },
  } as AtomicConfigFile;
  await expect(createAccount(state, { config: failing })).rejects.toThrow("write failed");
  expect(state.repository.listAccounts()).toHaveLength(0);
  expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
  expect(configOf(state)).toEqual({ plugins: [], providers: {} });
});

test("definite config write failure fully restores an unchanged update", async () => {
  const state = fixture();
  await createAccount(state, {
    registry: registry({ discover: async () => ({ ...emptyCatalog(), language: [{ id: "old-model" }] }) }),
  });
  state.repository.writeDiagnostic(
    "person",
    diagnostics("CREDENTIAL_REFRESH_FAILED", { providerId: "person", retryable: true }),
  );
  const previousAccount = state.repository.readAccount("person");
  const previousCatalog = state.repository.readCatalog("person");
  const previousDiagnostics = state.repository.readDiagnostics("person");
  const previousConfig = configOf(state);
  const real = state.config;
  let transactions = 0;
  const failing = {
    async transaction<T>(mutate: Parameters<AtomicConfigFile["transaction"]>[0]): Promise<T> {
      const { result } = await mutate(await real.read());
      transactions += 1;
      if (transactions === 1) return result as T;
      throw new Error("write failed");
    },
  } as AtomicConfigFile;
  await expect(
    loginOAuthAccount(
      options(state, {
        config: failing,
        targetProviderId: "person",
        capability: undefined,
        renderAccountOptions: async () => ({
          publicValues: { tenant: "new-work" },
          secrets: { secret: "new-hidden" },
        }),
        registry: registry({
          login: async () => ({
            fingerprint: "person@example.com",
            suggestedKey: "ignored",
            label: "new-label",
            credentials: { token: "new-token" },
          }),
          discover: async () => ({ ...emptyCatalog(), language: [{ id: "new-model" }] }),
        }),
      }),
    ),
  ).rejects.toThrow("write failed");
  expect(state.repository.readAccount("person")).toEqual(previousAccount);
  expect(state.repository.readCatalog("person")).toEqual(previousCatalog);
  expect(state.repository.readDiagnostics("person")).toEqual(previousDiagnostics);
  expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
  expect(configOf(state)).toEqual(previousConfig);
});

test("uncertain config commit preserves the staged account and marker", async () => {
  const state = fixture();
  const real = state.config;
  const uncertain = {
    async transaction<T>(mutate: Parameters<AtomicConfigFile["transaction"]>[0]): Promise<T> {
      await mutate(await real.read());
      throw new AtomicConfigCommitUncertainError();
    },
  } as AtomicConfigFile;
  await expect(createAccount(state, { config: uncertain })).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
  expect(state.repository.readAccount("person")).not.toBeNull();
  expect(state.repository.listPendingAccountOperations()).toHaveLength(1);
});

test("a compensation superseded by a newer credential preserves data and emits only a safe diagnostic", async () => {
  const state = fixture();
  await createAccount(state);
  const real = state.config;
  let transactions = 0;
  const failing = {
    async transaction<T>(mutate: Parameters<AtomicConfigFile["transaction"]>[0]): Promise<T> {
      const { result } = await mutate(await real.read());
      transactions += 1;
      if (transactions === 1) return result as T;
      const applied = accountOf(state, "person");
      refreshCredential(state, applied.revision, { token: "newer" });
      throw new Error("write failed");
    },
  } as AtomicConfigFile;
  const logs: Parameters<PluginLogSink>[0][] = [];
  await expect(
    loginOAuthAccount(
      options(state, {
        config: failing,
        targetProviderId: "person",
        capability: undefined,
        logger: (entry) => logs.push(entry),
      }),
    ),
  ).rejects.toThrow("write failed");
  expect(state.repository.readAccount("person")?.credential).toEqual({ token: "newer" });
  expect(state.repository.readDiagnostics("person")).toContainEqual(
    expect.objectContaining({ code: "AUTHORIZATION_FAILED" }),
  );
  expect(JSON.stringify(logs)).not.toContain("hidden");
});

test("superseded recovery compensation preserves newer data and writes a safe diagnostic", async () => {
  const state = fixture();
  await createAccount(state);
  const current = accountOf(state, "person");
  const operation = state.repository.stageAccountOperation({
    kind: "update",
    targetDigest: "different-digest",
    expectedRuntimeRevision: current.runtimeRevision,
    account: {
      providerId: "person",
      plugin: current.plugin,
      capability: current.capability,
      fingerprint: current.fingerprint,
      options: current.options,
      secrets: current.secrets,
      credential: { token: "staged" },
      catalog: {
        kind: "preserve",
        diagnostic: diagnostics("CATALOG_UNAVAILABLE", { providerId: "person", retryable: true }),
      },
    },
  });
  const applied = accountOf(state, "person");
  refreshCredential(state, applied.revision, { token: "super-secret-token" });
  state.sqlite
    .query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?")
    .run(operation.operationId);
  await recoverPendingAccountOperations(state.config, state.repository, {
    mode: "cli",
    now: () => PENDING_OPERATION_TTL_MS + 1,
  });
  expect(state.repository.readAccount("person")?.credential).toEqual({ token: "super-secret-token" });
  const diagnostic = state.repository.readDiagnostics("person").find(({ code }) => code === "AUTHORIZATION_FAILED");
  expect(diagnostic).toBeDefined();
  expect(diagnostic?.summary).not.toContain("super-secret-token");
});
