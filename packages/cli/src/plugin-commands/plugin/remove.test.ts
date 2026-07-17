import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmPackageCacheDir } from "@aio-proxy/core";
import { getLocale, setLocale } from "@aio-proxy/i18n";
import { definePlugin } from "@aio-proxy/plugin-sdk";
import {
  BuiltInPluginRemovalError,
  PluginSecretPurgeConflictError,
  pluginList,
  pluginPrune,
  pluginRemove,
} from "./index";
import { createPluginTestScope } from "./test-support";

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe("plugin list, remove, and prune", () => {
  test("list includes built-ins and configured third parties without options or secrets", async () => {
    const secret = "vault-secret-value";
    const { deps, lines, values } = scope.harness({
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

  test("list resolves plugin metadata using the current locale while retaining canonical identity", async () => {
    const originalLocale = getLocale();
    const packageName = "@example/localized-list";
    const descriptor = definePlugin(() => {}, {
      label: { default: "Localized plugin", "zh-Hans": "本地化插件" },
      description: { default: "English description", "zh-Hans": "中文描述" },
    });
    const state = scope.harness({ providers: {}, plugins: [packageName] });
    try {
      await setLocale("zh-Hans");
      await pluginList(
        {},
        {
          ...state.deps,
          builtInNames: new Set([packageName]),
          builtIns: [{ packageName, version: "built-in", descriptor }],
        },
      );
      expect(state.lines.join("\n")).toContain(`本地化插件 (${packageName})`);
      expect(state.lines.join("\n")).toContain("中文描述");
    } finally {
      await setLocale(originalLocale);
    }
  });

  test("production list imports a real cached ESM plugin from its file URL exactly once", async () => {
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-list-real-"));
    scope.trackHome(home);
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

  test("remove preserves secrets by default and purge uses a second confirmation after config success", async () => {
    const state = scope.harness({ providers: {}, plugins: ["third-party-plugin"] });
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
    const state = scope.harness({ providers: {}, plugins: ["third-party-plugin"] });
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
    const state = scope.harness({ providers: {}, plugins: ["third-party-plugin"] });
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
    const state = scope.harness({ providers: {}, plugins: ["third-party-plugin"] });
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
    const state = scope.harness({ providers: {}, plugins: ["third-party-plugin"] });
    state.values.set("third-party-plugin", { revision: 1, value: { token: "remove" } });
    await pluginRemove("third-party-plugin", { purgeSecrets: true, yes: true }, { ...state.deps, isTTY: false });
    expect(state.values.has("third-party-plugin")).toBe(false);
  });

  test("purge reports a conflict when a concurrent secret update wins", async () => {
    const state = scope.harness({ providers: {}, plugins: ["third-party-plugin"] });
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
    const { deps } = scope.harness();
    await expect(pluginRemove("@aio-proxy/plugin-github-copilot", { yes: true }, deps)).rejects.toBeInstanceOf(
      BuiltInPluginRemovalError,
    );
  });

  test("prune conservatively keeps plugin and raw ai-sdk package names", async () => {
    const { deps } = scope.harness({
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
    const state = scope.harness({ providers: {}, plugins: [] });
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
