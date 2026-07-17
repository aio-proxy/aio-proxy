import {
  authorization,
  configOf,
  createAccount,
  deleteOAuthAccount,
  emptyCatalog,
  expect,
  fixture,
  loginOAuthAccount,
  options,
  type PluginRepository,
  registry,
  test,
  zod,
} from "./test-support";

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
