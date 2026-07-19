import type { PluginLogSink } from "../diagnostic";

import {
  adapter,
  definePlugin,
  expect,
  install,
  jest,
  loadPluginRegistry,
  options,
  PLUGIN_SETUP_TIMEOUT_MS,
  test,
  zod,
} from "./test-support";

test("options schema failure rejects before setup", async () => {
  install("@example/options");
  let setups = 0;
  const descriptor = definePlugin(
    () => {
      setups++;
    },
    {
      options: {
        schema: zod.object({ count: zod.number() }),
        form: [{ type: "number", key: "count", label: "Count" }],
      },
    },
  );
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/options", options: { count: "wrong" } }],
      importPackage: async () => ({ default: descriptor }),
    }),
  );
  expect(setups).toBe(0);
  expect(snapshot.plugins.get("@example/options")?.state).toMatchObject({
    status: "failed",
    diagnostic: { code: "PLUGIN_OPTIONS_INVALID" },
  });
});

test("options async validation shares the setup deadline and late setup stays sealed", async () => {
  let resolveValidation: ((value: unknown) => void) | undefined;
  const schema = {
    safeParse() {},
    safeParseAsync() {
      return new Promise((resolve) => {
        resolveValidation = resolve;
      });
    },
  };
  const descriptor = definePlugin(
    (api) => {
      api.oauth.register(adapter("late-options"));
    },
    { options: { schema: schema as never, form: [] } },
  );
  jest.useFakeTimers();

  try {
    let snapshot: Awaited<ReturnType<typeof loadPluginRegistry>> | undefined;
    const loading = loadPluginRegistry(
      options({
        builtIns: [{ packageName: "@example/options-timeout", version: "1.0.0", descriptor }],
      }),
    );
    loading.then((value) => {
      snapshot = value;
    });
    await Promise.resolve();
    jest.advanceTimersByTime(PLUGIN_SETUP_TIMEOUT_MS);
    for (let index = 0; index < 10; index++) await Promise.resolve();

    const timedOutSnapshot = snapshot;
    resolveValidation?.({ success: true, data: {} });
    for (let index = 0; index < 10; index++) await Promise.resolve();

    expect(timedOutSnapshot?.plugins.get("@example/options-timeout")?.state.status).toBe("failed");
    expect(timedOutSnapshot?.registry.resolveOAuth("@example/options-timeout", "late-options")).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});

test("public config cannot supply a secret field and plugin secret is merged", async () => {
  install("@example/secret-options");
  let received: unknown;
  const descriptor = definePlugin(
    (_api, value) => {
      received = value;
    },
    {
      options: {
        schema: zod.object({ endpoint: zod.string(), token: zod.string() }),
        form: [
          { type: "text", key: "endpoint", label: "Endpoint" },
          { type: "secret", key: "token", label: "Token" },
        ],
      },
    },
  );
  const rejected = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/secret-options", options: { endpoint: "x", token: "public" } }],
      importPackage: async () => ({ default: descriptor }),
      secrets: { readPluginSecret: () => ({ token: "private" }) },
    }),
  );
  expect(rejected.plugins.get("@example/secret-options")?.state.status).toBe("failed");
  expect(received).toBeUndefined();

  const accepted = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/secret-options", options: { endpoint: "x" } }],
      importPackage: async () => ({ default: descriptor }),
      secrets: { readPluginSecret: () => ({ token: "private" }) },
    }),
  );
  expect(accepted.plugins.get("@example/secret-options")?.state.status).toBe("ready");
  expect(received).toEqual({ endpoint: "x", token: "private" });
});

test("secret collection skips hostile nested properties and still redacts later array values", async () => {
  install("@example/hostile-secret-options");
  const nested: Record<string, unknown> = {};
  Object.defineProperty(nested, "blocked", {
    enumerable: true,
    get() {
      throw new Error("blocked getter");
    },
  });
  Object.assign(nested, { tokens: ["loader-array-secret", ""], cycle: nested });
  let setupCalled = false;
  const logs: Parameters<PluginLogSink>[0][] = [];
  const descriptor = definePlugin(
    () => {
      setupCalled = true;
      throw new Error("loader-array-secret");
    },
    {
      options: {
        schema: zod.object({ nested: zod.any() }),
        form: [],
      },
    },
  );

  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/hostile-secret-options" }],
      importPackage: async () => ({ default: descriptor }),
      logger: (entry: Parameters<PluginLogSink>[0]) => logs.push(entry),
      secrets: { readPluginSecret: () => ({ nested }) },
    }),
  );

  expect(setupCalled).toBe(true);
  expect(snapshot.plugins.get("@example/hostile-secret-options")?.state.status).toBe("failed");
  expect(JSON.stringify(logs)).not.toContain("loader-array-secret");
});

test.each([
  ["third party public options", { options: { unexpected: true }, secret: undefined }],
  ["third party retained secret", { options: undefined, secret: { token: "retained" } }],
  ["third party non-record secret", { options: undefined, secret: new Date(0) }],
])("descriptor without options rejects non-empty %s", async (_name, input) => {
  const packageName = `@example/no-options-${_name.replaceAll(" ", "-")}`;
  install(packageName);
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName, ...(input.options === undefined ? {} : { options: input.options }) }],
      importPackage: async () => ({ default: definePlugin(() => {}) }),
      secrets: { readPluginSecret: () => input.secret },
    }),
  );
  expect(snapshot.plugins.get(packageName)?.state.status).toBe("failed");
});

test("descriptor without options passes undefined to setup for empty records", async () => {
  install("@example/no-options-empty");
  let received: unknown = "not-called";
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/no-options-empty", options: {} }],
      importPackage: async () => ({ default: definePlugin((_api, value) => (received = value)) }),
      secrets: { readPluginSecret: () => ({}) },
    }),
  );
  expect(snapshot.plugins.get("@example/no-options-empty")?.state.status).toBe("ready");
  expect(received).toBeUndefined();
});

test("built-ins follow the no-options rule", async () => {
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/builtin-options", options: { unexpected: true } }],
      builtIns: [{ packageName: "@example/builtin-options", version: "1.0.0", descriptor: definePlugin(() => {}) }],
    }),
  );
  expect(snapshot.plugins.get("@example/builtin-options")?.state.status).toBe("failed");
});
