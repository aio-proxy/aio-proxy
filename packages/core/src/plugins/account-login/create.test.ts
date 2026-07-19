import {
  credentialSchema as antigravityCredentialSchema,
  CatalogDiscoveryError,
  discoverAntigravityCatalog,
  staticAntigravityCatalog,
} from "@aio-proxy/plugin-google-antigravity";

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

test("new account stores catalog-derived aliases whose targets exist", async () => {
  const state = fixture();
  await createAccount(state, {
    registry: registry({
      discover: async () => ({ ...emptyCatalog(), language: [{ id: "wire-low" }, { id: "wire-high" }] }),
      defaultAliases: () => ({
        logical: {
          model: "wire-low",
          preserve: false,
          variants: { high: { model: "wire-high", preserve: false } },
        },
      }),
    }),
  });

  expect(configOf(state)["providers"]).toMatchObject({
    person: {
      alias: {
        logical: {
          model: "wire-low",
          preserve: false,
          variants: { high: { model: "wire-high", preserve: false } },
        },
      },
    },
  });
});

test("new account rejects default aliases that reference an undiscovered target", async () => {
  const state = fixture();
  await expect(
    createAccount(state, {
      registry: registry({
        discover: async () => ({ ...emptyCatalog(), language: [{ id: "wire-low" }] }),
        defaultAliases: () => ({ logical: { model: "missing" } }),
      }),
    }),
  ).rejects.toThrow("default alias target");
});

test("new account uses a validated discovery fallback", async () => {
  const state = fixture();
  const logs: Parameters<PluginLogSink>[0][] = [];
  await createAccount(state, {
    registry: registry({
      discover: async () => Promise.reject(new Error("offline")),
      initialFallback: () => ({ ...emptyCatalog(), language: [{ id: "fallback" }] }),
    }),
    logger: (entry) => logs.push(entry),
  });

  expect(state.repository.readCatalog("person")?.catalog.language).toEqual([{ id: "fallback" }]);
  expect(state.repository.readDiagnostics("person")).toEqual([]);
  expect(logs.map(({ event }) => event)).not.toContain("plugin.catalog.discovery.failed");
});

test("first login reaches prod and applies the snapshot after both endpoint timeouts", async () => {
  const state = fixture();
  const urls: string[] = [];
  await createAccount(state, {
    registry: registry({
      credentialSchema: antigravityCredentialSchema as never,
      login: (async () => ({
        fingerprint: "person@example.com",
        suggestedKey: "person",
        credentials: {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: Number.MAX_SAFE_INTEGER,
          email: "person@example.com",
          projectId: "project-1",
        },
      })) as never,
      discover: (async (context) =>
        await discoverAntigravityCatalog(context as never, {
          fetch: async (input, init) => {
            urls.push(String(input));
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
            });
          },
          timeoutSignal: () => AbortSignal.timeout(1),
        })) as never,
      initialFallback: (error) =>
        error instanceof CatalogDiscoveryError && error.snapshotEligible ? staticAntigravityCatalog() : undefined,
    }),
  });

  expect(urls.map((url) => new URL(url).origin)).toEqual([
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]);
  expect(state.repository.readCatalog("person")?.catalog).toEqual(staticAntigravityCatalog());
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
  expect(logs.map(({ event }) => event)).toContain("plugin.catalog.discovery.failed");
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

test("catalog failure redaction skips hostile nested secret properties and collects later array values", async () => {
  const state = fixture();
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, "blocked", {
    enumerable: true,
    get() {
      throw new Error("blocked getter");
    },
  });
  Object.assign(nested, { tokens: ["login-array-secret", ""], cycle: nested });
  const logs: Parameters<PluginLogSink>[0][] = [];

  await expect(
    createAccount(state, {
      renderAccountOptions: async () => ({
        publicValues: { tenant: "work" },
        secrets: { secret: "hidden", nested },
      }),
      registry: registry({ discover: async () => Promise.reject(new Error("login-array-secret")) }),
      logger: (entry) => logs.push(entry),
    }),
  ).rejects.toThrow("blocked getter");

  expect(JSON.stringify(logs)).not.toContain("login-array-secret");
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
