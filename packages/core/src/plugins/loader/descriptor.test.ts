import {
  adapter,
  definePlugin,
  expect,
  install,
  loadPluginRegistry,
  options,
  PLUGIN_DESCRIPTOR_BRAND,
  PLUGIN_IMPORT_TIMEOUT_MS,
  type PluginDescriptor,
  type PluginPackageImporter,
  test,
} from "./test-support";

test("materializes descriptor display metadata as inert localized plain data", async () => {
  const label = Object.create(null) as Record<string, string>;
  label["default"] = "Example plugin";
  label["zh-Hans"] = "示例插件";
  const descriptor = definePlugin(() => {}, {
    label,
    description: { default: "Example description", "zh-Hans": "示例描述" },
  } as never);
  const snapshot = await loadPluginRegistry(
    options({
      builtIns: [{ packageName: "@example/metadata", version: "1.0.0", descriptor }],
    }),
  );

  const loaded = snapshot.plugins.get("@example/metadata");
  expect(loaded?.label).toEqual({ default: "Example plugin", "zh-Hans": "示例插件" });
  expect(loaded?.label).not.toBe(label);
  expect(Object.getPrototypeOf(loaded?.label as object)).toBe(Object.prototype);
  expect(loaded?.description).toEqual({ default: "Example description", "zh-Hans": "示例描述" });
});

test("invalid default export fails", async () => {
  install("@example/invalid-export");
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/invalid-export" }],
      importPackage: async () => ({ default: {} }),
    }),
  );
  expect(snapshot.plugins.get("@example/invalid-export")?.state).toMatchObject({
    status: "failed",
    diagnostic: { code: "PLUGIN_LOAD_FAILED" },
  });
  expect(snapshot.plugins.get("@example/invalid-export")?.version).toBe("1.0.0");
});

test("apiVersion mismatch fails with incompatibility", async () => {
  install("@example/incompatible");
  const descriptor = { ...definePlugin(() => {}), apiVersion: 999 };
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/incompatible" }],
      importPackage: async () => ({ default: descriptor }),
    }),
  );
  expect(snapshot.plugins.get("@example/incompatible")?.state).toMatchObject({
    status: "failed",
    diagnostic: { code: "PLUGIN_API_INCOMPATIBLE" },
  });
});

test("future descriptor brand with an unsupported integer apiVersion fails with incompatibility", async () => {
  install("@example/future-incompatible");
  const descriptor = {
    [Symbol.for("@aio-proxy/plugin-sdk/descriptor/v2")]: true,
    apiVersion: 2,
    metadata: {},
    setup() {},
  };
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/future-incompatible" }],
      importPackage: async () => ({ default: descriptor }),
    }),
  );
  expect(snapshot.plugins.get("@example/future-incompatible")?.state).toMatchObject({
    status: "failed",
    diagnostic: { code: "PLUGIN_API_INCOMPATIBLE" },
  });
});

test("built-in apiVersion mismatch also fails with incompatibility", async () => {
  const descriptor = { ...definePlugin(() => {}), apiVersion: 999 } as unknown as PluginDescriptor<unknown>;
  const snapshot = await loadPluginRegistry(
    options({
      builtIns: [{ packageName: "@example/builtin-incompatible", version: "1.0.0", descriptor }],
    }),
  );
  expect(snapshot.plugins.get("@example/builtin-incompatible")?.state).toMatchObject({
    status: "failed",
    diagnostic: { code: "PLUGIN_API_INCOMPATIBLE" },
  });
  expect(snapshot.plugins.get("@example/builtin-incompatible")?.version).toBe("1.0.0");
});

test("missing cached package returns PLUGIN_NOT_INSTALLED without importer activity", async () => {
  let imports = 0;
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/not-installed" }],
      importPackage: async () => {
        imports++;
        return {};
      },
    }),
  );
  expect(imports).toBe(0);
  expect(snapshot.plugins.get("@example/not-installed")?.state).toMatchObject({
    status: "failed",
    diagnostic: { code: "PLUGIN_NOT_INSTALLED" },
  });
});

test("manual built-in resolves embedded descriptor once without cache or import", async () => {
  let setups = 0;
  let imports = 0;
  const descriptor = definePlugin((api) => {
    setups++;
    api.oauth.register(adapter());
  });
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/builtin" }],
      builtIns: [{ packageName: "@example/builtin", version: "1.2.3", descriptor }],
      importPackage: async () => {
        imports++;
        return {};
      },
    }),
  );
  expect(imports).toBe(0);
  expect(setups).toBe(1);
  expect(snapshot.plugins.get("@example/builtin")).toMatchObject({
    version: "1.2.3",
    builtIn: true,
    state: { status: "ready" },
  });
  expect(snapshot.registry.resolveOAuth("@example/builtin", "default")).toBeDefined();
});

test("successful imports cache by packageName@version but setup reruns for each snapshot", async () => {
  install("@example/cached", "2.0.0");
  let imports = 0;
  let setups = 0;
  const descriptor = definePlugin(() => {
    setups++;
  });
  const importer: PluginPackageImporter = async ({ packageName, version, entrypoint, attempt }) => {
    imports++;
    expect(packageName).toBe("@example/cached");
    expect(version).toBe("2.0.0");
    expect(entrypoint.startsWith("file:")).toBe(true);
    expect(new URL(entrypoint).searchParams.get("aio_proxy_plugin_attempt")).toBe(attempt);
    return { default: descriptor };
  };
  const input = options({ enablements: [{ packageName: "@example/cached" }], importPackage: importer });
  await loadPluginRegistry(input);
  await loadPluginRegistry(input);
  expect(imports).toBe(1);
  expect(setups).toBe(2);
});

test("failed imports are evicted and use a fresh attempt token", async () => {
  install("@example/retry");
  const attempts: string[] = [];
  const importer: PluginPackageImporter = async ({ attempt }) => {
    attempts.push(attempt);
    if (attempts.length === 1) throw new Error("first evaluation failed");
    return { default: definePlugin(() => {}) };
  };
  const input = options({ enablements: [{ packageName: "@example/retry" }], importPackage: importer });
  expect((await loadPluginRegistry(input)).plugins.get("@example/retry")?.state.status).toBe("failed");
  expect((await loadPluginRegistry(input)).plugins.get("@example/retry")?.state.status).toBe("ready");
  expect(new Set(attempts).size).toBe(2);
});

test("import timeout fails and late rejection is handled", async () => {
  install("@example/import-timeout");
  const started = Date.now();
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/import-timeout" }],
      importPackage: () =>
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), PLUGIN_IMPORT_TIMEOUT_MS + 10)),
    }),
  );
  expect(Date.now() - started).toBeGreaterThanOrEqual(PLUGIN_IMPORT_TIMEOUT_MS - 50);
  expect(snapshot.plugins.get("@example/import-timeout")?.state.status).toBe("failed");
}, 12_000);

test("unbranded descriptor is rejected even when structurally compatible", async () => {
  install("@example/unbranded");
  const descriptor = {
    [PLUGIN_DESCRIPTOR_BRAND]: false,
    apiVersion: 1,
    metadata: {},
    setup() {},
  };
  const snapshot = await loadPluginRegistry(
    options({
      enablements: [{ packageName: "@example/unbranded" }],
      importPackage: async () => ({ default: descriptor }),
    }),
  );
  expect(snapshot.plugins.get("@example/unbranded")?.state.status).toBe("failed");
});
