import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  npmPackageCacheDir,
  type PluginSecretSnapshot,
} from "@aio-proxy/core";
import { definePlugin } from "@aio-proxy/plugin-sdk";
import { FormSchemaValidationError } from "../src/plugin-commands/form";
import {
  BuiltInPluginRemovalError,
  createCliPluginDiagnosticFactory,
  PluginConfigChangedError,
  PluginConfirmationRequiredError,
  PluginDescriptorInvalidError,
  type PluginLifecycleDeps,
  PluginNotConfiguredError,
  PluginNotInstalledError,
  PluginSecretPurgeConflictError,
  PluginSetupValidationError,
  pluginAdd,
  pluginConfig,
  pluginList,
  pluginPrune,
  pluginRemove,
} from "../src/plugin-commands/plugin";

const homes: string[] = [];

function harness(initial: Record<string, unknown> = { providers: {}, plugins: [] }) {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-command-"));
  homes.push(home);
  const path = join(home, "config.jsonc");
  writeFileSync(path, `${JSON.stringify(initial, null, 2)}\n`);
  const config = new AtomicConfigFile(path);
  const values = new Map<string, PluginSecretSnapshot>();
  const lines: string[] = [];
  const deps: PluginLifecycleDeps = {
    config,
    builtInNames: new Set(["@aio-proxy/plugin-github-copilot"]),
    confirm: async () => true,
    importPackage: async () => ({ default: definePlugin(() => {}) }),
    isTTY: true,
    findInstalledNpmPackage: async () => ({ version: "1.0.0", entrypoint: "/tmp/plugin.js" }),
    listInstalledNpmPackages: async () => [],
    npmAdd: async () => ({ version: "1.0.0", entrypoint: "/tmp/plugin.js" }),
    print: (line) => lines.push(line),
    prompts: {
      input: async () => "",
      password: async () => "",
      confirm: async () => true,
      select: async () => "",
    },
    removeNpmPackageCache: async () => false,
    repository: {
      readPluginSecret(plugin) {
        return values.get(plugin) ?? null;
      },
      writePluginSecret(plugin, expectedRevision, value) {
        const current = values.get(plugin) ?? null;
        if ((current?.revision ?? null) !== expectedRevision) throw new Error("Plugin secret revision mismatch");
        const snapshot = { value, revision: (current?.revision ?? 0) + 1 };
        values.set(plugin, snapshot);
        return snapshot;
      },
      deletePluginSecret(plugin, expectedRevision) {
        const current = values.get(plugin);
        if (current?.revision !== expectedRevision) return false;
        values.delete(plugin);
        return true;
      },
    },
  };
  return { config, deps, lines, path, values };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("plugin lifecycle commands", () => {
  test("non-interactive refusal and built-in add do not create config, database, or package cache", async () => {
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-cli-"));
    homes.push(home);
    const previousHome = process.env.AIO_PROXY_HOME;
    const previousLog = console.log;
    process.env.AIO_PROXY_HOME = home;
    console.log = () => {};
    try {
      await expect(pluginAdd("third-party-plugin", {})).rejects.toBeInstanceOf(PluginConfirmationRequiredError);
      expect(existsSync(join(home, "aio-proxy.db"))).toBe(false);
      expect(existsSync(join(home, "config.jsonc"))).toBe(false);
      expect(existsSync(join(home, "packages"))).toBe(false);

      await pluginAdd("@aio-proxy/plugin-github-copilot", {});
      expect(existsSync(join(home, "aio-proxy.db"))).toBe(false);
      expect(existsSync(join(home, "config.jsonc"))).toBe(false);
      expect(existsSync(join(home, "packages"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
      else process.env.AIO_PROXY_HOME = previousHome;
      console.log = previousLog;
    }
  });

  test("add refuses non-TTY without --yes and built-ins are npm-free no-ops", async () => {
    const { deps, lines } = harness();
    await expect(pluginAdd("third-party-plugin", {}, { ...deps, isTTY: false })).rejects.toBeInstanceOf(
      PluginConfirmationRequiredError,
    );

    let npmCalls = 0;
    await pluginAdd(
      "@aio-proxy/plugin-github-copilot",
      {},
      {
        ...deps,
        npmAdd: async () => {
          npmCalls += 1;
          throw new Error("must not install");
        },
      },
    );
    expect(npmCalls).toBe(0);
    expect(lines.join("\n")).toContain("already built in");
  });

  test("add orders trust before npm/import and failed import leaves plugins unchanged", async () => {
    const { deps, path } = harness();
    const events: string[] = [];
    await expect(
      pluginAdd(
        "third-party-plugin",
        {},
        {
          ...deps,
          confirm: async () => {
            events.push("trust");
            return true;
          },
          npmAdd: async () => {
            events.push("npm");
            return { version: "1.0.0", entrypoint: "/tmp/plugin.js" };
          },
          importPackage: async () => {
            events.push("import");
            throw new Error("bad import");
          },
        },
      ),
    ).rejects.toThrow("bad import");
    expect(events).toEqual(["trust", "npm", "import"]);
    expect(JSON.parse(readFileSync(path, "utf8")).plugins).toEqual([]);
  });

  test("add maps a malformed descriptor ConfigSpec to a localized descriptor error", async () => {
    const state = harness();
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: { safeParse() {}, async safeParseAsync() {} } as never,
        form: [{ type: "text", key: "", label: "Invalid" }],
      },
    });

    await expect(
      pluginAdd(
        "invalid-config-plugin",
        { yes: true },
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
        },
      ),
    ).rejects.toBeInstanceOf(PluginDescriptorInvalidError);
    expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual([]);
  });

  test("add writes string form without options and tuple form with public options", async () => {
    const empty = harness();
    await pluginAdd("empty-plugin", { yes: true }, empty.deps);
    expect(JSON.parse(readFileSync(empty.path, "utf8")).plugins).toEqual(["empty-plugin"]);

    const configured = harness();
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
      },
    });
    await pluginAdd(
      "configured-plugin",
      { yes: true },
      {
        ...configured.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: { ...configured.deps.prompts, input: async () => "https://example.test" },
      },
    );
    expect(JSON.parse(readFileSync(configured.path, "utf8")).plugins).toEqual([
      ["configured-plugin", { endpoint: "https://example.test" }],
    ]);
  });

  test("setup validation failure is safely reported before config or secrets are committed", async () => {
    const state = harness();
    const descriptor = definePlugin(() => {
      throw new Error("setup contained secret-value");
    });
    const result = pluginAdd(
      "hanging-plugin",
      { yes: true },
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
      },
    );
    await expect(result).rejects.toBeInstanceOf(PluginSetupValidationError);
    await expect(result).rejects.not.toThrow("secret-value");
    expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual([]);
    expect(state.values.size).toBe(0);
  });

  for (const command of ["add", "config"] as const) {
    test(`${command} isolates staged setup options from committed public and secret values`, async () => {
      const sentinel = `${command}-setup-secret-sentinel`;
      const setupMutation = `${command}-setup-mutated-secret`;
      let setupCompleted = false;
      const descriptor = definePlugin(
        (_api, value) => {
          const options = value as {
            settings: { nested: { value: string } };
            token: { value: string };
          };
          const capturedSecret = options.token.value;
          options.settings.nested.value = capturedSecret;
          Object.defineProperty(options.settings, "toJSON", {
            value: () => capturedSecret,
          });
          options.token.value = setupMutation;
          setupCompleted = true;
        },
        {
          options: {
            schema: {
              safeParse() {},
              async safeParseAsync(value: unknown) {
                const options = value as {
                  settings: { nested: { value: string } };
                  token: string | { value: string };
                };
                return {
                  success: true,
                  data: {
                    settings: options.settings,
                    token: typeof options.token === "string" ? { value: options.token } : options.token,
                  },
                };
              },
            } as never,
            form: [
              { type: "json", key: "settings", label: "Settings" },
              { type: "secret", key: "token", label: "Token" },
            ],
          },
        },
      );
      const packageName = `${command}-setup-isolation-plugin`;
      const state =
        command === "add"
          ? harness()
          : harness({
              providers: {},
              plugins: [[packageName, { settings: { nested: { value: "old-public" } } }]],
            });
      if (command === "config") {
        state.values.set(packageName, { revision: 1, value: { token: { value: "old-secret" } } });
      }
      const deps = {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: {
          ...state.deps.prompts,
          input: async () => '{"nested":{"value":"safe-public"}}',
          password: async () => sentinel,
        },
      };

      if (command === "add") await pluginAdd(packageName, { yes: true }, deps);
      else await pluginConfig(packageName, {}, deps);

      expect(setupCompleted).toBe(true);
      const configText = readFileSync(state.path, "utf8");
      expect(configText).not.toContain(sentinel);
      expect(configText).not.toContain(setupMutation);
      expect(JSON.parse(configText).plugins).toEqual([
        [packageName, { settings: { nested: { value: "safe-public" } } }],
      ]);
      expect(state.values.get(packageName)?.value).toEqual({ token: { value: sentinel } });
    });
  }

  test("list includes built-ins and configured third parties without options or secrets", async () => {
    const secret = "vault-secret-value";
    const { deps, lines, values } = harness({
      providers: {},
      plugins: [["third-party-plugin", { endpoint: "https://private.test" }]],
    });
    values.set("third-party-plugin", { revision: 1, value: { token: secret } });
    await pluginList({}, deps);
    const output = lines.join("\n");
    expect(output).toContain("@aio-proxy/plugin-github-copilot");
    expect(output).toContain("third-party-plugin");
    expect(output).not.toContain("private.test");
    expect(output).not.toContain(secret);
  });

  test("production list imports a real cached ESM plugin from its file URL exactly once", async () => {
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-list-real-"));
    homes.push(home);
    const packageName = `real-plugin-${crypto.randomUUID()}`;
    const previousHome = process.env.AIO_PROXY_HOME;
    const previousLog = console.log;
    const lines: string[] = [];
    process.env.AIO_PROXY_HOME = home;
    console.log = (line) => lines.push(String(line));
    try {
      writeFileSync(join(home, "config.jsonc"), JSON.stringify({ providers: {}, plugins: [packageName] }));
      const packageDir = join(npmPackageCacheDir(packageName), "node_modules", packageName);
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({ name: packageName, version: "1.0.0", main: "index.js" }),
      );
      writeFileSync(
        join(packageDir, "index.js"),
        'const brand = Symbol.for("@aio-proxy/plugin-sdk/descriptor/v1");\nexport default { [brand]: true, apiVersion: 1, metadata: {}, setup() {} };\n',
      );

      await pluginList({});
      expect(lines.join("\n")).toContain(`${packageName} configured`);
      expect(lines.join("\n")).not.toContain("failed");
    } finally {
      if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
      else process.env.AIO_PROXY_HOME = previousHome;
      console.log = previousLog;
    }
  });

  test("config retains blank secret and supports explicit clear", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "secret", key: "token", label: "Token" }],
      },
    });
    const retained = harness({ providers: {}, plugins: ["secret-plugin"] });
    retained.values.set("secret-plugin", { revision: 1, value: { token: "keep" } });
    await pluginConfig("secret-plugin", {}, { ...retained.deps, importPackage: async () => ({ default: descriptor }) });
    expect(retained.values.get("secret-plugin")?.value).toEqual({ token: "keep" });

    await pluginConfig(
      "secret-plugin",
      { clearSecret: ["token"] },
      {
        ...retained.deps,
        importPackage: async () => ({ default: descriptor }),
      },
    );
    expect(retained.values.get("secret-plugin")?.value).toEqual({});
  });

  test("config never publishes plaintext from secret fields removed by a new descriptor", async () => {
    const sentinel = "retired-secret-sentinel";
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
      },
    });
    const state = harness({ providers: {}, plugins: ["migrated-plugin"] });
    state.values.set("migrated-plugin", { revision: 1, value: { retiredToken: sentinel } });

    await pluginConfig(
      "migrated-plugin",
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: { ...state.deps.prompts, input: async () => "https://example.test" },
      },
    );

    const configText = readFileSync(state.path, "utf8");
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([["migrated-plugin", { endpoint: "https://example.test" }]]);
    expect(state.values.get("migrated-plugin")?.value).toEqual({});
  });

  test("config rejects a secret-renaming transform without publishing the secret", async () => {
    const sentinel = "transform-secret-sentinel";
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            const { endpoint, token } = value as { endpoint: string; token: string };
            return { success: true, data: { endpoint, leaked: token } };
          },
        } as never,
        form: [
          { type: "text", key: "endpoint", label: "Endpoint" },
          { type: "secret", key: "token", label: "Token" },
        ],
      },
    });
    const state = harness({ providers: {}, plugins: [["transform-plugin", { endpoint: "https://old.test" }]] });
    state.values.set("transform-plugin", { revision: 1, value: { token: sentinel } });

    const result = pluginConfig(
      "transform-plugin",
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: {
          ...state.deps.prompts,
          input: async () => "https://new.test",
          password: async () => "",
        },
      },
    );

    await expect(result).rejects.toBeInstanceOf(FormSchemaValidationError);
    await result.catch((error) => expect(String(error)).not.toContain(sentinel));
    const configText = readFileSync(state.path, "utf8");
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([["transform-plugin", { endpoint: "https://old.test" }]]);
  });

  test("config rejects a transform that copies a secret into a declared public field", async () => {
    const sentinel = "declared-public-secret-sentinel";
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            const { token } = value as { token: string };
            return { success: true, data: { endpoint: token, token } };
          },
        } as never,
        form: [
          { type: "text", key: "endpoint", label: "Endpoint" },
          { type: "secret", key: "token", label: "Token" },
        ],
      },
    });
    const state = harness({ providers: {}, plugins: [["copy-plugin", { endpoint: "https://old.test" }]] });
    state.values.set("copy-plugin", { revision: 1, value: { token: sentinel } });

    const result = pluginConfig(
      "copy-plugin",
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: {
          ...state.deps.prompts,
          input: async () => "https://new.test",
          password: async () => "",
        },
      },
    );

    await expect(result).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, "utf8");
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([["copy-plugin", { endpoint: "https://old.test" }]]);
  });

  test("config rejects a schema that mutates its input to copy a secret into public config", async () => {
    const sentinel = "mutated-input-secret-sentinel";
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            const input = value as { endpoint: string; token: string };
            input.endpoint = input.token;
            return { success: true, data: input };
          },
        } as never,
        form: [
          { type: "text", key: "endpoint", label: "Endpoint" },
          { type: "secret", key: "token", label: "Token" },
        ],
      },
    });
    const state = harness({ providers: {}, plugins: [["mutation-plugin", { endpoint: "https://old.test" }]] });

    const result = pluginConfig(
      "mutation-plugin",
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: {
          ...state.deps.prompts,
          input: async () => "https://new.test",
          password: async () => sentinel,
        },
      },
    );

    await expect(result).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, "utf8");
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([["mutation-plugin", { endpoint: "https://old.test" }]]);
    expect(state.values.get("mutation-plugin")).toBeUndefined();
  });

  test("config rejects an array toJSON closure that would serialize a secret", async () => {
    const sentinel = "array-to-json-secret-sentinel";
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            const { token } = value as { token: string };
            const endpoint: unknown[] = [];
            Object.defineProperty(endpoint, "toJSON", {
              value: () => token,
              enumerable: true,
            });
            return { success: true, data: { endpoint, token } };
          },
        } as never,
        form: [
          { type: "json", key: "endpoint", label: "Endpoint" },
          { type: "secret", key: "token", label: "Token" },
        ],
      },
    });
    const state = harness({ providers: {}, plugins: [["array-plugin", { endpoint: [] }]] });

    const result = pluginConfig(
      "array-plugin",
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: {
          ...state.deps.prompts,
          input: async () => "[]",
          password: async () => sentinel,
        },
      },
    );

    await expect(result).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, "utf8");
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([["array-plugin", { endpoint: [] }]]);
    expect(state.values.get("array-plugin")).toBeUndefined();
  });

  test("config rewrites a legacy non-record vault value to the current descriptor secret shape", async () => {
    const sentinel = "legacy-secret-sentinel";
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
      },
    });
    const state = harness({ providers: {}, plugins: ["legacy-secret-plugin"] });
    state.values.set("legacy-secret-plugin", { revision: 1, value: sentinel as never });

    await pluginConfig(
      "legacy-secret-plugin",
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: { ...state.deps.prompts, input: async () => "https://example.test" },
      },
    );

    expect(readFileSync(state.path, "utf8")).not.toContain(sentinel);
    expect(state.values.get("legacy-secret-plugin")?.value).toEqual({});
  });

  test("config uses an injected built-in descriptor without npm or dynamic import", async () => {
    const packageName = "@aio-proxy/plugin-github-copilot";
    const state = harness({ providers: {}, plugins: [packageName] });
    const descriptor = definePlugin(() => {});
    let externalAccess = 0;
    await pluginConfig(
      packageName,
      {},
      {
        ...state.deps,
        builtIns: [{ packageName, version: "built-in", descriptor }],
        findInstalledNpmPackage: async () => {
          externalAccess += 1;
          return null;
        },
        importPackage: async () => {
          externalAccess += 1;
          throw new Error("must not import built-in");
        },
      },
    );
    expect(externalAccess).toBe(0);
  });

  test("config never revives a plugin removed while its prompt is open", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
      },
    });
    const state = harness({ providers: {}, plugins: [["racing-plugin", { endpoint: "old" }]] });

    await expect(
      pluginConfig(
        "racing-plugin",
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: {
            ...state.deps.prompts,
            input: async () => {
              await state.config.replace((current) => ({ ...current, plugins: [] }));
              return "new";
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginNotConfiguredError);
    expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual([]);
  });

  test("config holds the installed package generation across import, prompt, staging, and commit", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
      },
    });
    const state = harness({ providers: {}, plugins: [["aba-plugin", { endpoint: "old" }]] });
    let generation = 1;
    let tail = Promise.resolve();
    const lifecycle: NonNullable<PluginLifecycleDeps["withNpmPackageLifecycle"]> = async (_packageName, use) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await use(async () => {});
      } finally {
        release();
      }
    };
    let replacement: Promise<void> | undefined;

    await pluginConfig(
      "aba-plugin",
      {},
      {
        ...state.deps,
        withNpmPackageLifecycle: lifecycle,
        findInstalledNpmPackage: async () => ({
          version: "1.0.0",
          entrypoint: `/tmp/aba-plugin-generation-${generation}.js`,
        }),
        importPackage: async ({ entrypoint }) => {
          expect(entrypoint).toContain("generation-1.js");
          return { default: descriptor };
        },
        prompts: {
          ...state.deps.prompts,
          input: async () => {
            replacement = lifecycle("aba-plugin", async () => {
              generation = 2;
              await state.config.replace((current) => ({ ...current, plugins: [] }));
              await state.config.replace((current) => ({
                ...current,
                plugins: [["aba-plugin", { endpoint: "old" }]],
              }));
            });
            await Bun.sleep(25);
            return "stale-prompt-value";
          },
        },
      },
    );
    await replacement;

    expect(generation).toBe(2);
    expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual([["aba-plugin", { endpoint: "old" }]]);
  });

  test("config rejects a changed entry and a missing cache under the lifecycle lock", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "text", key: "endpoint", label: "Endpoint" }],
      },
    });
    const changed = harness({ providers: {}, plugins: [["racing-plugin", { endpoint: "old" }]] });
    await expect(
      pluginConfig(
        "racing-plugin",
        {},
        {
          ...changed.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: {
            ...changed.deps.prompts,
            input: async () => {
              await changed.config.replace((current) => ({
                ...current,
                plugins: [["racing-plugin", { endpoint: "concurrent" }]],
              }));
              return "new";
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginConfigChangedError);

    const pruned = harness({ providers: {}, plugins: ["racing-plugin"] });
    await expect(
      pluginConfig(
        "racing-plugin",
        {},
        {
          ...pruned.deps,
          importPackage: async () => ({ default: descriptor }),
          findInstalledNpmPackage: async () => null,
          withNpmPackageLifecycle: async (_packageName, use) => use(async () => {}),
          prompts: { ...pruned.deps.prompts, input: async () => "new" },
        },
      ),
    ).rejects.toBeInstanceOf(PluginNotInstalledError);
    expect(JSON.parse(readFileSync(pruned.path, "utf8")).plugins).toEqual(["racing-plugin"]);
  });

  test("config rejects a concurrent secret revision even when its rendered secret value is unchanged", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [
          { type: "text", key: "endpoint", label: "Endpoint" },
          { type: "secret", key: "token", label: "Token" },
        ],
      },
    });
    const state = harness({ providers: {}, plugins: [["secret-race-plugin", { endpoint: "old" }]] });
    state.values.set("secret-race-plugin", { revision: 1, value: { token: "old-secret" } });

    await expect(
      pluginConfig(
        "secret-race-plugin",
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: {
            ...state.deps.prompts,
            input: async () => {
              state.values.set("secret-race-plugin", { revision: 2, value: { token: "new-secret" } });
              return "new-public";
            },
            password: async () => "",
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginConfigChangedError);
    expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual([["secret-race-plugin", { endpoint: "old" }]]);
    expect(state.values.get("secret-race-plugin")?.value).toEqual({ token: "new-secret" });
  });

  test("failed config write compensates only its own secret revision", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "secret", key: "token", label: "Token" }],
      },
    });
    const state = harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const realWrite = state.deps.repository.writePluginSecret.bind(state.deps.repository);
    const brokenConfig = {
      read: state.deps.config.read.bind(state.deps.config),
      transaction: async (mutate: Parameters<AtomicConfigFile["transaction"]>[0]) => {
        const current = await state.deps.config.read();
        await mutate(current);
        realWrite("secret-plugin", 2, { token: "concurrent" });
        throw new Error("config failed");
      },
      replace: state.deps.config.replace.bind(state.deps.config),
      providerEntry: state.deps.config.providerEntry.bind(state.deps.config),
      providerEntryDigest: state.deps.config.providerEntryDigest.bind(state.deps.config),
    } as AtomicConfigFile;
    await expect(
      pluginConfig(
        "secret-plugin",
        {},
        {
          ...state.deps,
          config: brokenConfig,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, password: async () => "new" },
        },
      ),
    ).rejects.toThrow("config failed");
    expect(state.values.get("secret-plugin")).toEqual({ revision: 3, value: { token: "concurrent" } });
  });

  test("failed config write restores the prior secret when its applied revision is current", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "secret", key: "token", label: "Token" }],
      },
    });
    const state = harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const brokenConfig = {
      read: state.deps.config.read.bind(state.deps.config),
      transaction: async (mutate: Parameters<AtomicConfigFile["transaction"]>[0]) => {
        await mutate(await state.deps.config.read());
        throw new Error("config failed");
      },
      replace: state.deps.config.replace.bind(state.deps.config),
      providerEntry: state.deps.config.providerEntry.bind(state.deps.config),
      providerEntryDigest: state.deps.config.providerEntryDigest.bind(state.deps.config),
    } as AtomicConfigFile;

    await expect(
      pluginConfig(
        "secret-plugin",
        {},
        {
          ...state.deps,
          config: brokenConfig,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, password: async () => "new" },
        },
      ),
    ).rejects.toThrow("config failed");
    expect(state.values.get("secret-plugin")?.value).toEqual({ token: "old" });
  });

  test("an uncertain committed config never compensates its applied secret", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "secret", key: "token", label: "Token" }],
      },
    });
    const state = harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const uncertainConfig = {
      read: state.deps.config.read.bind(state.deps.config),
      transaction: async (mutate: Parameters<AtomicConfigFile["transaction"]>[0]) => {
        const { next } = await mutate(await state.deps.config.read());
        writeFileSync(state.path, `${JSON.stringify(next, null, 2)}\n`);
        throw new AtomicConfigCommitUncertainError();
      },
      replace: state.deps.config.replace.bind(state.deps.config),
      providerEntry: state.deps.config.providerEntry.bind(state.deps.config),
      providerEntryDigest: state.deps.config.providerEntryDigest.bind(state.deps.config),
    } as AtomicConfigFile;

    await expect(
      pluginConfig(
        "secret-plugin",
        {},
        {
          ...state.deps,
          config: uncertainConfig,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, password: async () => "new" },
        },
      ),
    ).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
    expect(state.values.get("secret-plugin")?.value).toEqual({ token: "new" });
    expect(JSON.parse(readFileSync(state.path, "utf8"))).toEqual({ providers: {}, plugins: ["secret-plugin"] });
  });

  test("a committed config with release cleanup failure keeps its applied secret", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "secret", key: "token", label: "Token" }],
      },
    });
    const state = harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const home = dirname(state.path);
    const cleanupFailingConfig = {
      read: state.deps.config.read.bind(state.deps.config),
      transaction: (mutate: Parameters<AtomicConfigFile["transaction"]>[0]) =>
        state.deps.config.transaction(mutate, {
          async verify() {
            chmodSync(home, 0o500);
          },
        }),
      replace: state.deps.config.replace.bind(state.deps.config),
      providerEntry: state.deps.config.providerEntry.bind(state.deps.config),
      providerEntryDigest: state.deps.config.providerEntryDigest.bind(state.deps.config),
    } as AtomicConfigFile;

    try {
      await pluginConfig(
        "secret-plugin",
        {},
        {
          ...state.deps,
          config: cleanupFailingConfig,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, password: async () => "new" },
        },
      );
      expect(state.values.get("secret-plugin")?.value).toEqual({ token: "new" });
      expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual(["secret-plugin"]);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  test("failed config compensation surfaces storage errors while its revision is still current", async () => {
    const descriptor = definePlugin(() => {}, {
      options: {
        schema: {
          safeParse() {},
          async safeParseAsync(value: unknown) {
            return { success: true, data: value };
          },
        } as never,
        form: [{ type: "secret", key: "token", label: "Token" }],
      },
    });
    const state = harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const brokenConfig = {
      read: state.deps.config.read.bind(state.deps.config),
      transaction: async (mutate: Parameters<AtomicConfigFile["transaction"]>[0]) => {
        await mutate(await state.deps.config.read());
        throw new Error("config failed");
      },
      replace: state.deps.config.replace.bind(state.deps.config),
      providerEntry: state.deps.config.providerEntry.bind(state.deps.config),
      providerEntryDigest: state.deps.config.providerEntryDigest.bind(state.deps.config),
    } as AtomicConfigFile;
    let writes = 0;

    await expect(
      pluginConfig(
        "secret-plugin",
        {},
        {
          ...state.deps,
          config: brokenConfig,
          repository: {
            ...state.deps.repository,
            writePluginSecret(plugin, expectedRevision, value) {
              writes += 1;
              if (writes === 2) throw new Error("rollback storage failed");
              return state.deps.repository.writePluginSecret(plugin, expectedRevision, value);
            },
          },
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, password: async () => "new" },
        },
      ),
    ).rejects.toThrow("rollback storage failed");
  });

  test("localized diagnostics interpolate only safe identifiers", () => {
    const diagnostic = createCliPluginDiagnosticFactory()("CAPABILITY_MISSING", {
      plugin: "secret-value\ninvalid",
      capability: "secret-value invalid",
      providerId: "secret-value invalid",
      retryable: false,
    });
    expect(diagnostic.summary).not.toContain("secret-value");
  });

  test("remove preserves secrets by default and purge uses a second confirmation after config success", async () => {
    const state = harness({ providers: {}, plugins: ["third-party-plugin"] });
    state.values.set("third-party-plugin", { revision: 1, value: { token: "keep" } });
    await pluginRemove("third-party-plugin", { yes: true }, state.deps);
    expect(state.values.get("third-party-plugin")?.value).toEqual({ token: "keep" });

    writeFileSync(state.path, JSON.stringify({ providers: {}, plugins: ["third-party-plugin"] }));
    let confirmations = 0;
    await pluginRemove(
      "third-party-plugin",
      { purgeSecrets: true },
      {
        ...state.deps,
        confirm: async () => {
          confirmations += 1;
          return true;
        },
      },
    );
    expect(confirmations).toBe(2);
    expect(state.values.has("third-party-plugin")).toBe(false);
  });

  test("declining the post-remove purge keeps secrets and reports retention", async () => {
    const state = harness({ providers: {}, plugins: ["third-party-plugin"] });
    state.values.set("third-party-plugin", { revision: 1, value: { token: "keep" } });
    let confirmations = 0;
    await pluginRemove(
      "third-party-plugin",
      { purgeSecrets: true },
      {
        ...state.deps,
        confirm: async () => {
          confirmations += 1;
          if (confirmations === 2) {
            expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual([]);
            return false;
          }
          return true;
        },
      },
    );
    expect(state.values.get("third-party-plugin")?.value).toEqual({ token: "keep" });
    expect(state.lines.join("\n")).toContain("retained");
  });

  test("purge snapshots the secret revision only after the second confirmation", async () => {
    const state = harness({ providers: {}, plugins: ["third-party-plugin"] });
    state.values.set("third-party-plugin", { revision: 1, value: { token: "old" } });
    let confirmations = 0;
    await pluginRemove(
      "third-party-plugin",
      { purgeSecrets: true },
      {
        ...state.deps,
        confirm: async () => {
          confirmations += 1;
          if (confirmations === 2) {
            state.values.set("third-party-plugin", { revision: 2, value: { token: "new" } });
          }
          return true;
        },
      },
    );
    expect(state.values.has("third-party-plugin")).toBe(false);
  });

  test("purge preserves credentials when the plugin is re-added during the second confirmation", async () => {
    const state = harness({ providers: {}, plugins: ["third-party-plugin"] });
    state.values.set("third-party-plugin", { revision: 1, value: { token: "old" } });
    let confirmations = 0;

    await expect(
      pluginRemove(
        "third-party-plugin",
        { purgeSecrets: true },
        {
          ...state.deps,
          confirm: async () => {
            confirmations += 1;
            if (confirmations === 2) {
              writeFileSync(state.path, JSON.stringify({ providers: {}, plugins: ["third-party-plugin"] }));
              state.values.set("third-party-plugin", { revision: 2, value: { token: "re-added" } });
            }
            return true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginSecretPurgeConflictError);
    expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual(["third-party-plugin"]);
    expect(state.values.get("third-party-plugin")?.value).toEqual({ token: "re-added" });
  });

  test("--yes permits non-interactive secret purge", async () => {
    const state = harness({ providers: {}, plugins: ["third-party-plugin"] });
    state.values.set("third-party-plugin", { revision: 1, value: { token: "remove" } });
    await pluginRemove("third-party-plugin", { purgeSecrets: true, yes: true }, { ...state.deps, isTTY: false });
    expect(state.values.has("third-party-plugin")).toBe(false);
  });

  test("purge reports a conflict when a concurrent secret update wins", async () => {
    const state = harness({ providers: {}, plugins: ["third-party-plugin"] });
    state.values.set("third-party-plugin", { revision: 1, value: { token: "old" } });

    await expect(
      pluginRemove(
        "third-party-plugin",
        { purgeSecrets: true, yes: true },
        {
          ...state.deps,
          repository: {
            ...state.deps.repository,
            deletePluginSecret(plugin, expectedRevision) {
              state.values.set(plugin, { revision: expectedRevision + 1, value: { token: "new" } });
              return false;
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(PluginSecretPurgeConflictError);
    expect(state.values.get("third-party-plugin")?.value).toEqual({ token: "new" });
    expect(state.lines.join("\n")).not.toContain("purged");
  });

  test("built-ins cannot be removed", async () => {
    const { deps } = harness();
    await expect(pluginRemove("@aio-proxy/plugin-github-copilot", { yes: true }, deps)).rejects.toBeInstanceOf(
      BuiltInPluginRemovalError,
    );
  });

  test("prune conservatively keeps plugin and raw ai-sdk package names", async () => {
    const { deps } = harness({
      plugins: ["@aio-proxy/plugin-github-copilot", ["used-plugin", { anything: true }]],
      providers: {
        broken: { kind: "ai-sdk", package: "used-provider", options: "malformed-but-package-still-counts" },
        legacyUpper: { kind: "ai-sdk", package: "Legacy-Provider" },
        invalidName: { kind: "ai-sdk", packageName: "../malformed" },
        api: { kind: "api", package: "not-an-ai-sdk-package" },
      },
    });
    const removed: string[] = [];
    const packages = [
      "used-plugin",
      "@aio-proxy/plugin-github-copilot",
      "used-provider",
      "Legacy-Provider",
      "../malformed",
      "not-an-ai-sdk-package",
      "unused-package",
    ];
    await pluginPrune(
      { yes: true },
      {
        ...deps,
        listInstalledNpmPackages: async () =>
          packages.map((packageName) => ({
            packageName,
            version: "1",
            entrypoint: "/tmp/x",
            cacheDir: `/tmp/${packageName}`,
          })),
        removeNpmPackageCache: async (packageName) => {
          removed.push(packageName);
          return true;
        },
      },
    );
    expect(removed).toEqual([
      "@aio-proxy/plugin-github-copilot",
      "../malformed",
      "not-an-ai-sdk-package",
      "unused-package",
    ]);
  });

  test("prune rechecks config under the package lifecycle lock before removal", async () => {
    const state = harness({ providers: {}, plugins: [] });
    let removed = false;
    await pluginPrune(
      { yes: true },
      {
        ...state.deps,
        listInstalledNpmPackages: async () => [
          { packageName: "racing-plugin", version: "1.0.0", entrypoint: "/tmp/racing.js", cacheDir: "/tmp/cache" },
        ],
        removeNpmPackageCache: async (_packageName, canRemove) => {
          await state.config.replace((current) => ({ ...current, plugins: ["racing-plugin"] }));
          removed = (await canRemove?.()) ?? true;
          return removed;
        },
      },
    );
    expect(removed).toBe(false);
  });
});
