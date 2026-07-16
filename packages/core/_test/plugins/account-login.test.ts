import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorizationPort, ModelCatalog, OAuthAdapter } from "@aio-proxy/plugin-sdk";
import { zod } from "@aio-proxy/plugin-sdk";
import { type OpenDbHandle, openDb } from "../../src/db";
import {
  ABSENT_PROVIDER_DIGEST,
  AccountCleanupPendingError,
  deleteOAuthAccount,
  LOGIN_TIMEOUT_MS,
  type LoginOAuthAccountOptions,
  loginOAuthAccount,
  OAuthLoginResultValidationError,
  ORPHAN_ACCOUNT_GRACE_MS,
  PENDING_OPERATION_TTL_MS,
  ProviderAccountAlreadyExistsError,
  ProviderAccountChangedError,
  ProviderFingerprintMismatchError,
  RECOVERY_DRAIN_RETRY_MS,
  recoverPendingAccountOperations,
} from "../../src/plugins/account-login";
import { AtomicConfigCommitUncertainError, AtomicConfigFile, digestProviderEntry } from "../../src/plugins/config-file";
import type { DiagnosticFactory, PluginLogSink } from "../../src/plugins/diagnostic";
import { createPluginRegistryHost, type PluginRegistry } from "../../src/plugins/registry";
import { createPluginRepository, type PluginRepository } from "../../src/plugins/repository";

const roots: string[] = [];
const handles: OpenDbHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const emptyCatalog = (): ModelCatalog => ({
  language: [],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});

const diagnostics: DiagnosticFactory = (code, options) => ({
  code,
  summary: code,
  retryable: options.retryable,
  occurredAt: "2026-07-15T00:00:00.000Z",
  ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
});

function fixture(initial: Record<string, unknown> = { plugins: [], providers: {} }) {
  const root = mkdtempSync(join(tmpdir(), "aio-proxy-account-login-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(path, `${JSON.stringify(initial)}\n`, { mode: 0o600 });
  const handle = openDb({ home: root });
  handles.push(handle);
  return {
    root,
    path,
    config: new AtomicConfigFile(path),
    repository: createPluginRepository(handle.sqlite),
    sqlite: handle.sqlite,
  };
}

function refreshCredential(state: ReturnType<typeof fixture>, expectedRevision: number, credential: unknown) {
  const owner = crypto.randomUUID();
  const now = Date.now();
  if (!state.repository.tryAcquireRefreshLease("person", owner, now, now + 60_000)) {
    throw new Error("lease unavailable");
  }
  try {
    return state.repository.compareAndSwapCredential("person", expectedRevision, owner, credential);
  } finally {
    state.repository.releaseRefreshLease("person", owner);
  }
}

type AdapterControls = {
  login?: OAuthAdapter<Record<string, unknown>, { token: string; refresh?: string }>["login"];
  discover?: OAuthAdapter<Record<string, unknown>, { token: string; refresh?: string }>["catalog"]["discover"];
  credentialSchema?: OAuthAdapter<Record<string, unknown>, unknown>["credentials"];
  accountSchema?: OAuthAdapter<Record<string, unknown>, unknown>["account"]["options"]["schema"];
};

function registry(controls: AdapterControls = {}): PluginRegistry {
  const host = createPluginRegistryHost();
  const staging = host.stage("@example/oauth");
  staging.api.oauth.register({
    id: "default",
    label: "Example OAuth",
    account: {
      options: {
        schema: controls.accountSchema ?? zod.object({ tenant: zod.string(), secret: zod.string() }),
        form: [
          { type: "text", key: "tenant", label: "Tenant" },
          { type: "secret", key: "secret", label: "Secret" },
        ],
      },
    },
    credentials: controls.credentialSchema ?? zod.object({ token: zod.string(), refresh: zod.string().optional() }),
    login:
      controls.login ??
      (async () => ({ fingerprint: "person@example.com", suggestedKey: "person", credentials: { token: "new" } })),
    catalog: { policy: { kind: "static" }, discover: controls.discover ?? (async () => emptyCatalog()) },
    async createRuntime() {
      throw new Error("not used");
    },
  });
  staging.seal();
  staging.commit();
  return host.registry;
}

const authorization: AuthorizationPort = {
  async presentDeviceCode() {},
  async loopback() {
    return { code: "code", redirectUri: "http://127.0.0.1/callback" };
  },
};

function options(
  state: ReturnType<typeof fixture>,
  overrides: Partial<LoginOAuthAccountOptions> = {},
): LoginOAuthAccountOptions {
  return {
    capability: { plugin: "@example/oauth", capability: "default" },
    registry: registry(),
    repository: state.repository,
    config: state.config,
    renderAccountOptions: async () => ({ publicValues: { tenant: "work" }, secrets: { secret: "hidden" } }),
    createAuthorization: () => authorization,
    diagnostics,
    logger: () => {},
    ...overrides,
  };
}

async function createAccount(state: ReturnType<typeof fixture>, overrides: Partial<LoginOAuthAccountOptions> = {}) {
  return loginOAuthAccount(options(state, overrides));
}

function configOf(state: ReturnType<typeof fixture>): Record<string, unknown> {
  return JSON.parse(readFileSync(state.path, "utf8")) as Record<string, unknown>;
}

function accountOf(state: ReturnType<typeof fixture>, providerId: string) {
  const account = state.repository.readAccount(providerId);
  if (account === null) throw new Error(`Missing test account: ${providerId}`);
  return account;
}

describe("account login transaction", () => {
  test("exports the specified constants", () => {
    expect(LOGIN_TIMEOUT_MS).toBe(20 * 60_000);
    expect(PENDING_OPERATION_TTL_MS).toBe(30 * 60_000);
    expect(ORPHAN_ACCOUNT_GRACE_MS).toBe(30 * 60_000);
    expect(RECOVERY_DRAIN_RETRY_MS).toBe(5_000);
    expect(ABSENT_PROVIDER_DIGEST).toBe("absent");
  });

  test("credential schema failure and malformed login metadata perform no write", async () => {
    for (const result of [
      { fingerprint: "person@example.com", suggestedKey: "person", credentials: { nope: true } },
      { fingerprint: " ", suggestedKey: "person", credentials: { token: "new" } },
      { fingerprint: 42, suggestedKey: "person", credentials: { token: "new" } },
      { fingerprint: "person@example.com", suggestedKey: 42, credentials: { token: "new" } },
      { fingerprint: "person@example.com", suggestedKey: "person", label: 42, credentials: { token: "new" } },
      { fingerprint: "person@example.com", suggestedKey: "person", expiresAt: Infinity, credentials: { token: "new" } },
    ]) {
      const state = fixture();
      await expect(
        createAccount(state, { registry: registry({ login: async () => result as never }) }),
      ).rejects.toBeInstanceOf(OAuthLoginResultValidationError);
      expect(state.repository.listAccounts()).toHaveLength(0);
      expect(configOf(state)).toEqual({ plugins: [], providers: {} });
    }
  });

  test("malformed providers config is not overwritten during login", async () => {
    const state = fixture({ plugins: [], providers: "malformed" });
    await expect(createAccount(state)).rejects.toThrow();
    expect(configOf(state)).toEqual({ plugins: [], providers: "malformed" });
    expect(state.repository.listAccounts()).toHaveLength(0);
  });

  test("uses one deadline signal for form, authorization, login, and discovery", async () => {
    const state = fixture();
    const signals: AbortSignal[] = [];
    await createAccount(state, {
      registry: registry({
        login: async (context) => {
          signals.push(context.signal);
          return { fingerprint: "person@example.com", suggestedKey: "person", credentials: { token: "new" } };
        },
        discover: async (context) => {
          signals.push(context.signal);
          return emptyCatalog();
        },
      }),
      renderAccountOptions: async ({ signal }) => {
        signals.push(signal);
        return { publicValues: { tenant: "work" }, secrets: { secret: "hidden" } };
      },
      createAuthorization(signal) {
        signals.push(signal);
        return authorization;
      },
    });
    expect(signals).toHaveLength(4);
    expect(new Set(signals.slice(0, 3)).size).toBe(1);
    expect(signals[3]).not.toBe(signals[0]);
  });

  test("an outer abort stops an adapter that ignores its signal without committing", async () => {
    const state = fixture();
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const login = createAccount(state, {
      signal: controller.signal,
      registry: registry({
        login: async () => {
          entered();
          return new Promise<never>(() => {});
        },
      }),
    });
    await started;
    controller.abort(new Error("cancelled"));
    await expect(login).rejects.toThrow("cancelled");
    expect(state.repository.listAccounts()).toHaveLength(0);
  });

  test("abort during the final config lock wait prevents staging and config mutation", async () => {
    const state = fixture();
    const controller = new AbortController();
    let lockHeld!: () => void;
    let releaseLock!: () => void;
    let discoveryFinished!: () => void;
    const holding = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const discovered = new Promise<void>((resolve) => {
      discoveryFinished = resolve;
    });
    const lock = state.config.transaction(async (current) => {
      lockHeld();
      await blocked;
      return { next: current, result: undefined };
    });
    await holding;
    const login = createAccount(state, {
      signal: controller.signal,
      registry: registry({
        discover: async () => {
          discoveryFinished();
          return emptyCatalog();
        },
      }),
    });
    await discovered;
    await Bun.sleep(25);
    const outcome = login.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    controller.abort(new Error("cancelled"));
    const beforeRelease = await Promise.race([outcome, Bun.sleep(1_000).then(() => ({ status: "waiting" as const }))]);
    releaseLock();
    await lock;
    await outcome;
    expect(beforeRelease).toMatchObject({ status: "rejected", error: { message: "cancelled" } });
    expect(state.repository.listAccounts()).toHaveLength(0);
    expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
    expect(configOf(state)).toEqual({ plugins: [], providers: {} });
  });

  test("an aborted re-login does not cancel a pending delete during preflight", async () => {
    const state = fixture();
    await createAccount(state);
    const marker = await deleteOAuthAccount({
      providerId: "person",
      config: state.config,
      repository: state.repository,
    });
    await state.config.replace((current) => ({
      ...current,
      providers: { person: { kind: "oauth", plugin: "@example/oauth", capability: "default", enabled: true } },
    }));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      loginOAuthAccount(
        options(state, {
          targetProviderId: "person",
          capability: undefined,
          signal: controller.signal,
        }),
      ),
    ).rejects.toThrow("cancelled");
    expect(state.repository.listPendingAccountOperations()).toContainEqual(
      expect.objectContaining({ operationId: marker.operationId, kind: "delete" }),
    );
  });

  test("abort during async account schema validation prevents adapter login", async () => {
    const state = fixture();
    const controller = new AbortController();
    let validationStarted!: () => void;
    let releaseValidation!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let loginCalls = 0;
    const accountSchema = zod.object({ tenant: zod.string(), secret: zod.string() }).superRefine(async () => {
      validationStarted();
      await blocked;
    });
    const login = createAccount(state, {
      signal: controller.signal,
      registry: registry({
        accountSchema,
        login: async () => {
          loginCalls += 1;
          return { fingerprint: "person@example.com", suggestedKey: "person", credentials: { token: "new" } };
        },
      }),
    });
    await started;
    controller.abort(new Error("cancelled"));
    releaseValidation();
    await expect(login).rejects.toThrow("cancelled");
    expect(loginCalls).toBe(0);
    expect(state.repository.listAccounts()).toHaveLength(0);
  });

  test("abort during async credential schema validation prevents discovery and persistence", async () => {
    const state = fixture();
    const controller = new AbortController();
    let validationStarted!: () => void;
    let releaseValidation!: () => void;
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let discoveryCalls = 0;
    const credentialSchema = zod.object({ token: zod.string() }).superRefine(async () => {
      validationStarted();
      await blocked;
    });
    const login = createAccount(state, {
      signal: controller.signal,
      registry: registry({
        credentialSchema,
        discover: async () => {
          discoveryCalls += 1;
          return emptyCatalog();
        },
      }),
    });
    await started;
    controller.abort(new Error("cancelled"));
    releaseValidation();
    await expect(login).rejects.toThrow("cancelled");
    expect(discoveryCalls).toBe(0);
    expect(state.repository.listAccounts()).toHaveLength(0);
  });

  test("abort triggered by final staging is compensated before config commit", async () => {
    const state = fixture();
    const controller = new AbortController();
    const repository = {
      ...state.repository,
      stageAccountOperation(input: Parameters<PluginRepository["stageAccountOperation"]>[0]) {
        const operation = state.repository.stageAccountOperation(input);
        controller.abort(new Error("cancelled"));
        return operation;
      },
    } as PluginRepository;
    await expect(createAccount(state, { repository, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(state.repository.listAccounts()).toHaveLength(0);
    expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
    expect(configOf(state)).toEqual({ plugins: [], providers: {} });
  });

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

  test("authorization failure preserves the old account revision", async () => {
    const state = fixture();
    await createAccount(state);
    await expect(
      loginOAuthAccount(
        options(state, {
          targetProviderId: "person",
          capability: undefined,
          registry: registry({ login: async () => Promise.reject(new Error("denied")) }),
        }),
      ),
    ).rejects.toThrow("denied");
    expect(state.repository.readAccount("person")).toMatchObject({ revision: 1, runtimeRevision: 1 });
  });

  test("explicit re-login rejects fingerprint mismatch without changing the old revision", async () => {
    const state = fixture();
    await createAccount(state);
    await expect(
      loginOAuthAccount(
        options(state, {
          targetProviderId: "person",
          capability: undefined,
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
});

describe("delete and crash recovery", () => {
  test("malformed providers config prevents delete staging", async () => {
    const state = fixture({ plugins: [], providers: "malformed" });
    await expect(
      deleteOAuthAccount({ providerId: "person", config: state.config, repository: state.repository }),
    ).rejects.toThrow();
    expect(state.repository.listPendingAccountOperations()).toHaveLength(0);
    expect(configOf(state)).toEqual({ plugins: [], providers: "malformed" });
  });

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
    matching.sqlite
      .query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?")
      .run(op.operationId);
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
    state.sqlite
      .query("UPDATE oauth_pending_operation SET created_at = 100 WHERE operation_id = ?")
      .run(op.operationId);
    const result = await recoverPendingAccountOperations(state.config, state.repository, {
      mode: "cli",
      now: () => 200,
    });
    expect(result.nextRunAt).toBe(100 + PENDING_OPERATION_TTL_MS);
    expect(state.repository.listPendingAccountOperations()).toHaveLength(1);
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

  test("typed duplicate error contains only canonical guidance", () => {
    expect(new ProviderAccountAlreadyExistsError("provider-1")).toMatchObject({
      existingProviderId: "provider-1",
      suggestedCommand: "aio-proxy provider login --provider provider-1",
    });
    expect(new ProviderAccountAlreadyExistsError("provider; echo unsafe")).toMatchObject({
      existingProviderId: "provider; echo unsafe",
      suggestedCommand: "aio-proxy provider login --provider 'provider; echo unsafe'",
    });
  });
});
