import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  definePlugin,
  type OAuthAdapter,
  PLUGIN_DESCRIPTOR_BRAND,
  type PluginDescriptor,
  zod,
} from "@aio-proxy/plugin-sdk";
import { npmPackageCacheDir } from "../../src/npm";
import type { DiagnosticFactory } from "../../src/plugins/diagnostic";
import {
  loadPluginRegistry,
  PLUGIN_IMPORT_TIMEOUT_MS,
  PLUGIN_SETUP_TIMEOUT_MS,
  type PluginPackageImporter,
} from "../../src/plugins/loader";

const originalHome = process.env.AIO_PROXY_HOME;
const home = mkdtempSync(`${tmpdir()}/aio-proxy-plugin-loader-`);

beforeAll(() => {
  process.env.AIO_PROXY_HOME = home;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

const diagnostics: DiagnosticFactory = (code, options) => ({
  code,
  retryable: options.retryable,
  summary: code,
  occurredAt: new Date(0).toISOString(),
  ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
});

function install(packageName: string, version = "1.0.0") {
  const packageRoot = `${npmPackageCacheDir(packageName)}/node_modules/${packageName}`;
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(`${packageRoot}/package.json`, JSON.stringify({ name: packageName, version, main: "index.js" }));
  writeFileSync(`${packageRoot}/index.js`, "export default {};\n");
}

function adapter(id = "default"): OAuthAdapter {
  return {
    id,
    label: "Example",
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error("not called");
    },
    catalog: {
      policy: { kind: "static" },
      async discover() {
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
    async createRuntime() {
      throw new Error("not called");
    },
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    enablements: [] as { packageName: string; options?: unknown }[],
    builtIns: [] as { packageName: string; version: string; descriptor: PluginDescriptor<unknown> }[],
    diagnostics,
    importPackage: async () => ({}),
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
    ...overrides,
  };
}

describe("loadPluginRegistry", () => {
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

  test("built-ins follow the no-options rule", async () => {
    const snapshot = await loadPluginRegistry(
      options({
        enablements: [{ packageName: "@example/builtin-options", options: { unexpected: true } }],
        builtIns: [{ packageName: "@example/builtin-options", version: "1.0.0", descriptor: definePlugin(() => {}) }],
      }),
    );
    expect(snapshot.plugins.get("@example/builtin-options")?.state.status).toBe("failed");
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
});
