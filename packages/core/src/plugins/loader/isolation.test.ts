import {
  adapter,
  definePlugin,
  expect,
  install,
  loadPluginRegistry,
  options,
  PLUGIN_SETUP_TIMEOUT_MS,
  test,
} from "./test-support";

test("configured third-party setup failures suggest the exact plugin config command", async () => {
  install("@example/setup-failure-command");
  const descriptor = definePlugin(() => {
    throw new Error("setup failed");
  });
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/setup-failure-command" }],
      importPackage: async () => ({ default: descriptor }),
    }),
  );

  expect(snapshot.plugins.get("@example/setup-failure-command")?.state).toMatchObject({
    status: "failed",
    diagnostic: {
      code: "PLUGIN_LOAD_FAILED",
      suggestedCommand: "aio-proxy plugin config @example/setup-failure-command",
    },
  });
});

test("unconfigured built-in failures do not suggest an unavailable config command", async () => {
  const descriptor = definePlugin(() => {
    throw new Error("setup failed");
  });
  const snapshot = await loadPluginRegistry(
    options({
      builtIns: [{ packageName: "@example/unconfigured-builtin", version: "1.0.0", descriptor }],
    }),
  );

  const state = snapshot.plugins.get("@example/unconfigured-builtin")?.state;
  expect(state).toMatchObject({ status: "failed", diagnostic: { code: "PLUGIN_LOAD_FAILED" } });
  expect(state?.status === "failed" ? state.diagnostic.suggestedCommand : "unexpected-ready").toBeUndefined();
});

test("configured built-in failures suggest the exact plugin config command", async () => {
  const descriptor = definePlugin(() => {
    throw new Error("setup failed");
  });
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/configured-builtin" }],
      builtIns: [{ packageName: "@example/configured-builtin", version: "1.0.0", descriptor }],
    }),
  );

  expect(snapshot.plugins.get("@example/configured-builtin")?.state).toMatchObject({
    status: "failed",
    diagnostic: {
      code: "PLUGIN_LOAD_FAILED",
      suggestedCommand: "aio-proxy plugin config @example/configured-builtin",
    },
  });
});

test("a throwing plugin secret reader fails only that plugin", async () => {
  const broken = definePlugin(() => {});
  const healthy = definePlugin((api) => api.oauth.register(adapter()));
  const snapshot = await loadPluginRegistry(
    options({
      builtIns: [
        { packageName: "@example/broken-secret", version: "1.0.0", descriptor: broken },
        { packageName: "@example/healthy", version: "1.0.0", descriptor: healthy },
      ],
      secrets: {
        readPluginSecret(plugin: string) {
          if (plugin === "@example/broken-secret") throw new Error("secret read failed");
          return undefined;
        },
      },
    }),
  );

  expect(snapshot.plugins.get("@example/broken-secret")?.state).toMatchObject({
    status: "failed",
    diagnostic: { code: "PLUGIN_LOAD_FAILED" },
  });
  expect(snapshot.plugins.get("@example/healthy")?.state.status).toBe("ready");
  expect(snapshot.registry.resolveOAuth("@example/healthy", "default")).toBeDefined();
});

test("setup timeout seals staging against late registration", async () => {
  const descriptor = definePlugin(async (api) => {
    await new Promise((resolve) => setTimeout(resolve, PLUGIN_SETUP_TIMEOUT_MS + 10));
    api.oauth.register(adapter("late"));
  });
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/setup-timeout" }],
      builtIns: [{ packageName: "@example/setup-timeout", version: "1.0.0", descriptor }],
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(snapshot.plugins.get("@example/setup-timeout")?.state.status).toBe("failed");
  expect(snapshot.registry.resolveOAuth("@example/setup-timeout", "late")).toBeUndefined();
}, 7_000);

test("malicious plugin errors do not stop later plugins from loading", async () => {
  const malicious = Object.create(Error.prototype, {
    message: {
      get: () => {
        throw new Error("message getter");
      },
    },
    stack: {
      get: () => {
        throw new Error("stack getter");
      },
    },
  });
  const snapshot = await loadPluginRegistry(
    options({
      builtIns: [
        {
          packageName: "@example/malicious-error",
          version: "1.0.0",
          descriptor: definePlugin(() => {
            throw malicious;
          }),
        },
        { packageName: "@example/after-malicious", version: "1.0.0", descriptor: definePlugin(() => {}) },
      ],
    }),
  );

  expect(snapshot.plugins.get("@example/malicious-error")?.state.status).toBe("failed");
  expect(snapshot.plugins.get("@example/after-malicious")?.state.status).toBe("ready");
});
