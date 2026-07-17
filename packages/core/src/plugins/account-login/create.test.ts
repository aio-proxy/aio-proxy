import {
  AccountCleanupPendingError,
  configOf,
  createAccount,
  deleteOAuthAccount,
  emptyCatalog,
  expect,
  fixture,
  loginOAuthAccount,
  options,
  type PluginLogSink,
  registry,
  test,
} from "./test-support";

test("stores account, structured canonical config, credentials, and initial catalog", async () => {
  const state = fixture();
  const result = await createAccount(state, {
    registry: registry({ discover: async () => ({ ...emptyCatalog(), language: [{ id: "model-1" }] }) }),
  });
  expect(result.providerId).toBe("person");
  expect(state.repository.readAccount("person")).toMatchObject({
    providerId: "person",
    plugin: "@example/oauth",
    capability: "default",
    fingerprint: "person@example.com",
    options: { tenant: "work" },
    secrets: { secret: "hidden" },
    credential: { token: "new" },
    revision: 1,
    runtimeRevision: 1,
  });
  expect(state.repository.readCatalog("person")?.catalog.language).toEqual([{ id: "model-1" }]);
  expect(configOf(state)["providers"]).toEqual({
    person: {
      kind: "oauth",
      plugin: "@example/oauth",
      capability: "default",
      options: { tenant: "work" },
      enabled: true,
    },
  });
  expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
});

test("discovery refreshes the in-memory credential before persistence", async () => {
  const state = fixture();
  await createAccount(state, {
    registry: registry({
      discover: async ({ credentials }) => {
        const current = await credentials.read();
        await credentials.refresh(current.revision, async () => ({ value: { token: "refreshed" } }));
        return emptyCatalog();
      },
    }),
  });
  expect(state.repository.readAccount("person")?.credential).toEqual({ token: "refreshed" });
});

test("discovery credential refresh is single-flight and stale revisions skip exchange", async () => {
  const state = fixture();
  let exchanges = 0;
  await createAccount(state, {
    registry: registry({
      discover: async ({ credentials }) => {
        const current = await credentials.read();
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const exchange = async () => {
          exchanges += 1;
          await blocked;
          return { value: { token: "refreshed" } };
        };
        const first = credentials.refresh(current.revision, exchange);
        const second = credentials.refresh(current.revision, exchange);
        release();
        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult.snapshot.revision).toBe(1);
        expect(secondResult.snapshot.revision).toBe(1);
        const stale = await credentials.refresh(current.revision, exchange);
        expect(stale).toMatchObject({ status: "superseded", snapshot: { revision: 1 } });
        return emptyCatalog();
      },
    }),
  });
  expect(exchanges).toBe(1);
  expect(state.repository.readAccount("person")?.credential).toEqual({ token: "refreshed" });
});

test("initial discovery failure commits with CATALOG_UNAVAILABLE while re-login preserves last-known-good catalog", async () => {
  const state = fixture();
  const logs: Parameters<PluginLogSink>[0][] = [];
  await createAccount(state, {
    registry: registry({ discover: async () => Promise.reject(new Error("catalog token=new secret=hidden")) }),
    logger: (entry) => logs.push(entry),
  });
  expect(state.repository.readCatalog("person")).toBeNull();
  expect(state.repository.readDiagnostics("person")).toMatchObject([{ code: "CATALOG_UNAVAILABLE" }]);
  expect(JSON.stringify(logs)).not.toContain("token=new");
  expect(JSON.stringify(logs)).not.toContain("secret=hidden");

  state.repository.writeCatalog("person", { ...emptyCatalog(), language: [{ id: "known" }] }, 1);
  await loginOAuthAccount(
    options(state, {
      targetProviderId: "person",
      capability: undefined,
      registry: registry({ discover: async () => Promise.reject(new Error("offline")) }),
    }),
  );
  expect(state.repository.readCatalog("person")?.catalog.language).toEqual([{ id: "known" }]);
  expect(state.repository.readDiagnostics("person")).toMatchObject([{ code: "CATALOG_UNAVAILABLE" }]);
});

test("duplicate fingerprint reports canonical re-login only for a live structured entry", async () => {
  const state = fixture();
  await createAccount(state);
  await expect(createAccount(state)).rejects.toMatchObject({
    name: "ProviderAccountAlreadyExistsError",
    existingProviderId: "person",
    suggestedCommand: "aio-proxy provider login --provider person",
  });
  await state.config.replace((current) => ({ ...current, providers: {} }));
  await expect(createAccount(state)).rejects.toBeInstanceOf(AccountCleanupPendingError);
  expect(state.repository.readAccount("person")?.revision).toBe(1);

  const pending = fixture();
  await createAccount(pending);
  await deleteOAuthAccount({ providerId: "person", config: pending.config, repository: pending.repository });
  await pending.config.replace((current) => ({
    ...current,
    providers: {
      person: { kind: "oauth", plugin: "@example/oauth", capability: "default", enabled: true },
    },
  }));
  await expect(createAccount(pending)).rejects.toBeInstanceOf(AccountCleanupPendingError);
});
