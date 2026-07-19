import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@aio-proxy/plugin-sdk";
import {
  createDefaultPluginLifecycleDeps,
  createPluginConfirmation,
  PluginConfirmationRequiredError,
  PluginDescriptorInvalidError,
  type PluginLifecycleDeps,
  pluginAdd,
} from "./index";
import { createPluginTestScope, descriptorWithForm } from "./test-support";

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe("plugin add", () => {
  test("default plugin lifecycle dependencies bind embedded built-ins", () => {
    const deps = createDefaultPluginLifecycleDeps();
    try {
      expect(deps.builtIns?.map(({ packageName }) => packageName).sort()).toEqual([
        "@aio-proxy/plugin-github-copilot",
        "@aio-proxy/plugin-google-antigravity",
        "@aio-proxy/plugin-kimi-code",
        "@aio-proxy/plugin-openai-chatgpt",
      ]);
    } finally {
      deps.close?.();
    }
  });

  test("plugin trust and destructive confirmation defaults to no", async () => {
    let observed: { readonly message: string; readonly default?: boolean } | undefined;
    const confirm = createPluginConfirmation(async (config) => {
      observed = config;
      return false;
    });
    await expect(confirm("Trust this plugin?")).resolves.toBe(false);
    expect(observed).toEqual({ message: "Trust this plugin?", default: false });
  });

  test("non-interactive refusal and built-in add do not create config, database, or package cache", async () => {
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-cli-"));
    scope.trackHome(home);
    let defaultDeps: PluginLifecycleDeps | undefined;
    const previousHome = process.env.AIO_PROXY_HOME;
    const previousLog = console.log;
    process.env.AIO_PROXY_HOME = home;
    console.log = () => {};
    try {
      defaultDeps = createDefaultPluginLifecycleDeps();
      const nonInteractiveDeps = { ...defaultDeps, isTTY: false };
      await expect(pluginAdd("third-party-plugin", {}, nonInteractiveDeps)).rejects.toBeInstanceOf(
        PluginConfirmationRequiredError,
      );
      expect(existsSync(join(home, "aio-proxy.db"))).toBe(false);
      expect(existsSync(join(home, "config.jsonc"))).toBe(false);
      expect(existsSync(join(home, "packages"))).toBe(false);
      await pluginAdd("@aio-proxy/plugin-github-copilot", {}, nonInteractiveDeps);
      expect(existsSync(join(home, "aio-proxy.db"))).toBe(false);
      expect(existsSync(join(home, "config.jsonc"))).toBe(false);
      expect(existsSync(join(home, "packages"))).toBe(false);
    } finally {
      defaultDeps?.close?.();
      if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
      else process.env.AIO_PROXY_HOME = previousHome;
      console.log = previousLog;
    }
  });

  test("add refuses non-TTY without --yes and built-ins are npm-free no-ops", async () => {
    const { deps, lines } = scope.harness();
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
    const { deps, path } = scope.harness();
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

  test("add times out a hanging import, releases its lifecycle lock, and ignores late resolution", async () => {
    const state = scope.harness();
    let resolveImport!: (value: unknown) => void;
    const imported = new Promise<unknown>((resolve) => {
      resolveImport = resolve;
    });
    let released = false;
    const command = pluginAdd("hanging-add-plugin", { yes: true }, {
      ...state.deps,
      importTimeoutMs: 20,
      importPackage: async () => imported,
      withInstalledNpmPackage: async (_packageName, _registry, use) => {
        try {
          return await use({ version: "1.0.0", entrypoint: "/tmp/plugin.js" }, async () => {});
        } finally {
          released = true;
        }
      },
    } as PluginLifecycleDeps);
    const outcome = await Promise.race([
      command.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      Bun.sleep(100).then(() => "still-pending" as const),
    ]);
    const releasedBeforeLateResolution = released;
    const configBeforeLateResolution = JSON.parse(readFileSync(state.path, "utf8"));
    const secretsBeforeLateResolution = state.values.size;
    resolveImport({ default: definePlugin(() => {}) });
    await command.catch(() => {});
    await Bun.sleep(0);
    expect(outcome).toBeInstanceOf(PluginDescriptorInvalidError);
    expect(releasedBeforeLateResolution).toBe(true);
    expect(configBeforeLateResolution.plugins).toEqual([]);
    expect(secretsBeforeLateResolution).toBe(0);
    expect(released).toBe(true);
    expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual([]);
    expect(state.values.size).toBe(0);
  });

  test("add maps a malformed descriptor ConfigSpec to a localized descriptor error", async () => {
    const state = scope.harness();
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
    const empty = scope.harness();
    await pluginAdd("empty-plugin", { yes: true }, empty.deps);
    expect(JSON.parse(readFileSync(empty.path, "utf8")).plugins).toEqual(["empty-plugin"]);
    const configured = scope.harness();
    const descriptor = descriptorWithForm([{ type: "text", key: "endpoint", label: "Endpoint" }]);
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
});
