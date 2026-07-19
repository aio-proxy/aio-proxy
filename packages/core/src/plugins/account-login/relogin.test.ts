import {
  AccountCleanupPendingError,
  accountOf,
  configOf,
  createAccount,
  deleteOAuthAccount,
  diagnostics,
  emptyCatalog,
  expect,
  fixture,
  loginOAuthAccount,
  options,
  ProviderAccountChangedError,
  ProviderFingerprintMismatchError,
  refreshCredential,
  registry,
  test,
} from "./test-support";

test("explicit re-login preloads options and secrets, fixes Provider ID, and preserves routing fields", async () => {
  const state = fixture();
  await createAccount(state);
  await state.config.replace((current) => ({
    ...current,
    providers: {
      person: {
        ...((current["providers"] as Record<string, unknown>)["person"] as object),
        enabled: false,
        weight: 9,
        name: "Work",
        alias: { chat: { model: "model-1" } },
      },
    },
  }));
  let preloaded: unknown;
  const result = await loginOAuthAccount(
    options(state, {
      targetProviderId: "person",
      capability: undefined,
      renderAccountOptions: async (input) => {
        preloaded = input;
        return { publicValues: { tenant: "new" }, secrets: { secret: "new-secret" } };
      },
    }),
  );
  expect(preloaded).toMatchObject({
    currentPublicValues: { tenant: "work" },
    currentSecrets: { secret: "hidden" },
  });
  expect(result.providerId).toBe("person");
  expect((configOf(state)["providers"] as Record<string, unknown>)["person"]).toMatchObject({
    enabled: false,
    weight: 9,
    name: "Work",
    alias: { chat: { model: "model-1" } },
    options: { tenant: "new" },
  });
});

test("explicit re-login atomically applies a requested provider patch with account options", async () => {
  const state = fixture();
  await createAccount(state);

  await loginOAuthAccount(
    options(state, {
      targetProviderId: "person",
      capability: undefined,
      providerPatch: {
        name: "Personal",
        enabled: false,
        weight: 4,
        alias: { chat: { model: "model-2" } },
      },
      renderAccountOptions: async () => ({
        publicValues: { tenant: "personal" },
        secrets: { secret: "replacement" },
      }),
    }),
  );

  expect((configOf(state).providers as Record<string, unknown>).person).toMatchObject({
    kind: "oauth",
    plugin: "@example/oauth",
    capability: "default",
    name: "Personal",
    enabled: false,
    weight: 4,
    alias: { chat: { model: "model-2" } },
    options: { tenant: "personal" },
  });
  expect(accountOf(state, "person")).toMatchObject({
    options: { tenant: "personal" },
    secrets: { secret: "replacement" },
  });
});

test("re-login preserves an edited alias despite catalog suggestions", async () => {
  const state = fixture();
  await createAccount(state);
  await state.config.replace((current) => ({
    ...current,
    providers: {
      person: {
        ...((current["providers"] as Record<string, unknown>)["person"] as object),
        alias: { logical: { model: "edited" } },
      },
    },
  }));
  let suggestions = 0;

  await loginOAuthAccount(
    options(state, {
      targetProviderId: "person",
      capability: undefined,
      registry: registry({
        discover: async () => ({ ...emptyCatalog(), language: [{ id: "suggested" }] }),
        defaultAliases: () => {
          suggestions += 1;
          return { logical: { model: "suggested" } };
        },
      }),
    }),
  );

  expect((configOf(state)["providers"] as Record<string, unknown>)["person"]).toMatchObject({
    alias: { logical: { model: "edited" } },
  });
  expect(suggestions).toBe(0);
});

test("missing config/account preflight makes no network call and reports cleanup-pending", async () => {
  const state = fixture();
  let calls = 0;
  await expect(
    loginOAuthAccount(
      options(state, {
        targetProviderId: "missing",
        capability: undefined,
        registry: registry({
          login: async () => {
            calls += 1;
            throw new Error("called");
          },
        }),
      }),
    ),
  ).rejects.toBeInstanceOf(AccountCleanupPendingError);
  expect(calls).toBe(0);
});

test("re-login requires both entry and account, and cancels an older delete marker only after the entry is re-added", async () => {
  const state = fixture();
  await createAccount(state);
  const marker = await deleteOAuthAccount({
    providerId: "person",
    config: state.config,
    repository: state.repository,
  });
  await expect(
    loginOAuthAccount(options(state, { targetProviderId: "person", capability: undefined })),
  ).rejects.toBeInstanceOf(AccountCleanupPendingError);
  expect(state.repository.listPendingAccountOperations()).toEqual([marker]);

  await state.config.replace((current) => ({
    ...current,
    providers: {
      person: { kind: "oauth", plugin: "@example/oauth", capability: "default", enabled: true },
    },
  }));
  await loginOAuthAccount(options(state, { targetProviderId: "person", capability: undefined }));
  expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
  expect(state.repository.readAccount("person")?.runtimeRevision).toBe(2);
});

test("explicit re-login rejects fingerprint mismatch without changing the old revision", async () => {
  const state = fixture();
  await createAccount(state);
  const before = configOf(state);
  await expect(
    loginOAuthAccount(
      options(state, {
        targetProviderId: "person",
        capability: undefined,
        providerPatch: {
          name: "Must not save",
          enabled: false,
          weight: undefined,
          alias: { unsafe: { model: "other" } },
        },
        registry: registry({
          login: async () => ({
            fingerprint: "other@example.com",
            suggestedKey: "other",
            credentials: { token: "x" },
          }),
        }),
      }),
    ),
  ).rejects.toBeInstanceOf(ProviderFingerprintMismatchError);
  expect(state.repository.readAccount("person")?.revision).toBe(1);
  expect(configOf(state)).toEqual(before);
});

test("credential-only refresh is allowed during re-login but runtime revision changes invalidate it", async () => {
  const state = fixture();
  await createAccount(state);
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const relogin = loginOAuthAccount(
    options(state, {
      targetProviderId: "person",
      capability: undefined,
      registry: registry({
        login: async () => {
          entered();
          await waiting;
          return { fingerprint: "person@example.com", suggestedKey: "person", credentials: { token: "relogin" } };
        },
      }),
    }),
  );
  await started;
  expect(refreshCredential(state, 1, { token: "refresh" })?.revision).toBe(2);
  release();
  await relogin;
  expect(state.repository.readAccount("person")).toMatchObject({
    revision: 3,
    runtimeRevision: 2,
    credential: { token: "relogin" },
  });

  let releaseSecond!: () => void;
  let enteredSecond!: () => void;
  const waitingSecond = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const startedSecond = new Promise<void>((resolve) => {
    enteredSecond = resolve;
  });
  const stale = loginOAuthAccount(
    options(state, {
      targetProviderId: "person",
      capability: undefined,
      registry: registry({
        login: async () => {
          enteredSecond();
          await waitingSecond;
          return { fingerprint: "person@example.com", suggestedKey: "person", credentials: { token: "stale" } };
        },
      }),
    }),
  );
  await startedSecond;
  const current = accountOf(state, "person");
  const pending = state.repository.stageAccountOperation({
    kind: "update",
    targetDigest: (await state.config.providerEntryDigest("person")) as string,
    expectedRuntimeRevision: current.runtimeRevision,
    account: {
      providerId: "person",
      plugin: current.plugin,
      capability: current.capability,
      fingerprint: current.fingerprint,
      options: current.options,
      secrets: current.secrets,
      credential: { token: "newer" },
      catalog: {
        kind: "preserve",
        diagnostic: diagnostics("CATALOG_UNAVAILABLE", { providerId: "person", retryable: true }),
      },
    },
  });
  state.repository.completeAccountOperation(pending.operationId);
  releaseSecond();
  await expect(stale).rejects.toBeInstanceOf(ProviderAccountChangedError);
});
