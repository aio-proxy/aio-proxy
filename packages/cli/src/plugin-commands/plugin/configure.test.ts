import { AtomicConfigCommitUncertainError, type AtomicConfigLockReleaseError } from "@aio-proxy/core";
import { definePlugin } from "@aio-proxy/plugin-sdk";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  PluginConfigChangedError,
  PluginDescriptorInvalidError,
  type PluginLifecycleDeps,
  PluginNotConfiguredError,
  PluginNotInstalledError,
  pluginConfig,
} from "./index";
import {
  configFacade,
  configureSecret,
  createPluginTestScope,
  secretDescriptor,
  textDescriptor,
  textSecretDescriptor,
} from "./test-support";

const scope = createPluginTestScope();
afterEach(scope.cleanup);
describe("plugin configure", () => {
  test("config retains blank secret and supports explicit clear", async () => {
    const descriptor = secretDescriptor();
    const state = scope.harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "keep" } });
    const deps = { ...state.deps, importPackage: async () => ({ default: descriptor }) };
    await pluginConfig("secret-plugin", {}, deps);
    expect(state.values.get("secret-plugin")?.value).toEqual({ token: "keep" });
    await pluginConfig("secret-plugin", { clearSecret: ["token"] }, deps);
    expect(state.values.get("secret-plugin")?.value).toEqual({});
  });
  test("config rewrites a legacy non-record vault value to the current descriptor secret shape", async () => {
    const sentinel = "legacy-secret-sentinel";
    const state = scope.harness({ providers: {}, plugins: ["legacy-secret-plugin"] });
    state.values.set("legacy-secret-plugin", { revision: 1, value: sentinel as never });
    await pluginConfig(
      "legacy-secret-plugin",
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: textDescriptor() }),
        prompts: { ...state.deps.prompts, input: async () => "https://example.test" },
      },
    );
    expect(readFileSync(state.path, "utf8")).not.toContain(sentinel);
    expect(state.values.get("legacy-secret-plugin")?.value).toEqual({});
  });
  test("config uses an injected built-in descriptor without npm or dynamic import", async () => {
    const packageName = "@aio-proxy/plugin-github-copilot";
    const state = scope.harness({ providers: {}, plugins: [packageName] });
    let externalAccess = 0;
    await pluginConfig(
      packageName,
      {},
      {
        ...state.deps,
        builtIns: [{ packageName, version: "built-in", descriptor: definePlugin(() => {}) }],
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
  test("config times out a hanging import, releases its lifecycle lock, and observes late rejection", async () => {
    const state = scope.harness({ providers: {}, plugins: ["hanging-config-plugin"] });
    let rejectImport!: (error: unknown) => void;
    const imported = new Promise<unknown>((_resolve, reject) => {
      rejectImport = reject;
    });
    let released = false;
    const command = pluginConfig("hanging-config-plugin", {}, {
      ...state.deps,
      importTimeoutMs: 20,
      importPackage: async () => imported,
      withNpmPackageLifecycle: async (_packageName, use) => {
        try {
          return await use(async () => {});
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
    const releasedBeforeLateRejection = released;
    const configBeforeLateRejection = JSON.parse(readFileSync(state.path, "utf8"));
    const secretsBeforeLateRejection = state.values.size;
    rejectImport(new Error("late import rejection"));
    await command.catch(() => {});
    await Bun.sleep(0);
    expect(outcome).toBeInstanceOf(PluginDescriptorInvalidError);
    expect(releasedBeforeLateRejection).toBe(true);
    expect(configBeforeLateRejection.plugins).toEqual(["hanging-config-plugin"]);
    expect(secretsBeforeLateRejection).toBe(0);
    expect(released).toBe(true);
    expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual(["hanging-config-plugin"]);
    expect(state.values.size).toBe(0);
  });
  test("config never revives a plugin removed while its prompt is open", async () => {
    const state = scope.harness({ providers: {}, plugins: [["racing-plugin", { endpoint: "old" }]] });
    await expect(
      pluginConfig(
        "racing-plugin",
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: textDescriptor() }),
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
    const state = scope.harness({ providers: {}, plugins: [["aba-plugin", { endpoint: "old" }]] });
    let generation = 1;
    let tail = Promise.resolve();
    const lifecycle: NonNullable<PluginLifecycleDeps["withNpmPackageLifecycle"]> = async (_packageName, use) => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => (release = resolve));
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
        findInstalledNpmPackage: async () => ({ version: "1", entrypoint: `/tmp/generation-${generation}.js` }),
        importPackage: async ({ entrypoint }) => {
          expect(entrypoint).toContain("generation-1.js");
          return { default: textDescriptor() };
        },
        prompts: {
          ...state.deps.prompts,
          input: async () => {
            replacement = lifecycle("aba-plugin", async () => {
              generation = 2;
              await state.config.replace((current) => ({ ...current, plugins: [] }));
              await state.config.replace((current) => ({ ...current, plugins: [["aba-plugin", { endpoint: "old" }]] }));
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
    const changed = scope.harness({ providers: {}, plugins: [["racing-plugin", { endpoint: "old" }]] });
    await expect(
      pluginConfig(
        "racing-plugin",
        {},
        {
          ...changed.deps,
          importPackage: async () => ({ default: textDescriptor() }),
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
    const pruned = scope.harness({ providers: {}, plugins: ["racing-plugin"] });
    await expect(
      pluginConfig(
        "racing-plugin",
        {},
        {
          ...pruned.deps,
          importPackage: async () => ({ default: textDescriptor() }),
          findInstalledNpmPackage: async () => null,
          withNpmPackageLifecycle: async (_packageName, use) => use(async () => {}),
          prompts: { ...pruned.deps.prompts, input: async () => "new" },
        },
      ),
    ).rejects.toBeInstanceOf(PluginNotInstalledError);
    expect(JSON.parse(readFileSync(pruned.path, "utf8")).plugins).toEqual(["racing-plugin"]);
  });
  test("config rejects a concurrent secret revision even when its rendered secret value is unchanged", async () => {
    const state = scope.harness({ providers: {}, plugins: [["secret-race-plugin", { endpoint: "old" }]] });
    state.values.set("secret-race-plugin", { revision: 1, value: { token: "old-secret" } });
    await expect(
      pluginConfig(
        "secret-race-plugin",
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: textSecretDescriptor() }),
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
    const state = scope.harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const realWrite = state.deps.repository.writePluginSecret.bind(state.deps.repository);
    const config = configFacade(state, async (mutate) => {
      await mutate(await state.deps.config.read());
      realWrite("secret-plugin", 2, { token: "concurrent" });
      throw new Error("config failed");
    });
    await expect(configureSecret(state, config)).rejects.toThrow("config failed");
    expect(state.values.get("secret-plugin")).toEqual({ revision: 3, value: { token: "concurrent" } });
  });
  test("an uncertain committed config never compensates its applied secret", async () => {
    const state = scope.harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const config = configFacade(state, async (mutate) => {
      const { next } = await mutate(await state.deps.config.read());
      writeFileSync(state.path, `${JSON.stringify(next, null, 2)}\n`);
      throw new AtomicConfigCommitUncertainError();
    });
    await expect(configureSecret(state, config)).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
    expect(state.values.get("secret-plugin")?.value).toEqual({ token: "new" });
    expect(JSON.parse(readFileSync(state.path, "utf8"))).toEqual({ providers: {}, plugins: ["secret-plugin"] });
  });
  test("a committed config with release cleanup failure keeps its applied secret", async () => {
    const state = scope.harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const home = dirname(state.path);
    const config = configFacade(state, (mutate) =>
      state.deps.config.transaction(mutate, {
        async verify() {
          chmodSync(home, 0o500);
        },
      }),
    );
    try {
      await expect(configureSecret(state, config)).rejects.toMatchObject({
        name: "AtomicConfigLockReleaseError",
        cause: { code: "EACCES" },
      } satisfies Partial<AtomicConfigLockReleaseError>);
      expect(state.values.get("secret-plugin")?.value).toEqual({ token: "new" });
      expect(JSON.parse(readFileSync(state.path, "utf8")).plugins).toEqual(["secret-plugin"]);
    } finally {
      chmodSync(home, 0o700);
    }
  });
});
