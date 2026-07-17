import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { definePlugin } from "@aio-proxy/plugin-sdk";
import { FormSchemaValidationError } from "../form";
import { createCliPluginDiagnosticFactory, PluginSetupValidationError, pluginAdd, pluginConfig } from "./index";
import {
  configFacade,
  configureSecret,
  createPluginTestScope,
  descriptorWithForm,
  textDescriptor,
} from "./test-support";

const scope = createPluginTestScope();
afterEach(scope.cleanup);

describe("plugin descriptor security", () => {
  test("setup validation failure is safely reported before config or secrets are committed", async () => {
    const state = scope.harness();
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

  test.each([
    "add",
    "config",
  ] as const)("%s isolates staged setup options from committed public and secret values", async (command) => {
    const sentinel = `${command}-setup-secret-sentinel`;
    const setupMutation = `${command}-setup-mutated-secret`;
    let setupCompleted = false;
    const descriptor = definePlugin(
      (_api, value) => {
        const options = value as { settings: { nested: { value: string } }; token: { value: string } };
        const capturedSecret = options.token.value;
        options.settings.nested.value = capturedSecret;
        Object.defineProperty(options.settings, "toJSON", { value: () => capturedSecret });
        options.token.value = setupMutation;
        setupCompleted = true;
      },
      {
        options: {
          schema: {
            safeParse() {},
            async safeParseAsync(value: unknown) {
              const options = value as { settings: { nested: { value: string } }; token: string | { value: string } };
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
        ? scope.harness()
        : scope.harness({ providers: {}, plugins: [[packageName, { settings: { nested: { value: "old-public" } } }]] });
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
    expect(JSON.parse(configText).plugins).toEqual([[packageName, { settings: { nested: { value: "safe-public" } } }]]);
    expect(state.values.get(packageName)?.value).toEqual({ token: { value: sentinel } });
  });

  test("config never publishes plaintext from secret fields removed by a new descriptor", async () => {
    const sentinel = "retired-secret-sentinel";
    const descriptor = textDescriptor();
    const state = scope.harness({ providers: {}, plugins: ["migrated-plugin"] });
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
    const descriptor = descriptorWithForm(
      [
        { type: "text", key: "endpoint", label: "Endpoint" },
        { type: "secret", key: "token", label: "Token" },
      ],
      (value) => {
        const { endpoint, token } = value as { endpoint: string; token: string };
        return { endpoint, leaked: token };
      },
    );
    const state = scope.harness({ providers: {}, plugins: [["transform-plugin", { endpoint: "https://old.test" }]] });
    state.values.set("transform-plugin", { revision: 1, value: { token: sentinel } });
    const result = pluginConfig(
      "transform-plugin",
      {},
      {
        ...state.deps,
        importPackage: async () => ({ default: descriptor }),
        prompts: { ...state.deps.prompts, input: async () => "https://new.test", password: async () => "" },
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
    const descriptor = descriptorWithForm(
      [
        { type: "text", key: "endpoint", label: "Endpoint" },
        { type: "secret", key: "token", label: "Token" },
      ],
      (value) => {
        const { token } = value as { token: string };
        return { endpoint: token, token };
      },
    );
    const state = scope.harness({ providers: {}, plugins: [["copy-plugin", { endpoint: "https://old.test" }]] });
    state.values.set("copy-plugin", { revision: 1, value: { token: sentinel } });
    await expect(
      pluginConfig(
        "copy-plugin",
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, input: async () => "https://new.test", password: async () => "" },
        },
      ),
    ).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, "utf8");
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([["copy-plugin", { endpoint: "https://old.test" }]]);
  });

  test("config rejects a schema that mutates its input to copy a secret into public config", async () => {
    const sentinel = "mutated-input-secret-sentinel";
    const descriptor = descriptorWithForm(
      [
        { type: "text", key: "endpoint", label: "Endpoint" },
        { type: "secret", key: "token", label: "Token" },
      ],
      (value) => {
        const input = value as { endpoint: string; token: string };
        input.endpoint = input.token;
        return input;
      },
    );
    const state = scope.harness({ providers: {}, plugins: [["mutation-plugin", { endpoint: "https://old.test" }]] });
    await expect(
      pluginConfig(
        "mutation-plugin",
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, input: async () => "https://new.test", password: async () => sentinel },
        },
      ),
    ).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, "utf8");
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([["mutation-plugin", { endpoint: "https://old.test" }]]);
    expect(state.values.get("mutation-plugin")).toBeUndefined();
  });

  test("config rejects an array toJSON closure that would serialize a secret", async () => {
    const sentinel = "array-to-json-secret-sentinel";
    const descriptor = descriptorWithForm(
      [
        { type: "json", key: "endpoint", label: "Endpoint" },
        { type: "secret", key: "token", label: "Token" },
      ],
      (value) => {
        const { token } = value as { token: string };
        const endpoint: unknown[] = [];
        Object.defineProperty(endpoint, "toJSON", { value: () => token, enumerable: true });
        return { endpoint, token };
      },
    );
    const state = scope.harness({ providers: {}, plugins: [["array-plugin", { endpoint: [] }]] });
    await expect(
      pluginConfig(
        "array-plugin",
        {},
        {
          ...state.deps,
          importPackage: async () => ({ default: descriptor }),
          prompts: { ...state.deps.prompts, input: async () => "[]", password: async () => sentinel },
        },
      ),
    ).rejects.toBeInstanceOf(FormSchemaValidationError);
    const configText = readFileSync(state.path, "utf8");
    expect(configText).not.toContain(sentinel);
    expect(JSON.parse(configText).plugins).toEqual([["array-plugin", { endpoint: [] }]]);
    expect(state.values.get("array-plugin")).toBeUndefined();
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

  test("failed config write restores the prior secret when its applied revision is current", async () => {
    const state = scope.harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const config = configFacade(state, async (mutate) => {
      await mutate(await state.deps.config.read());
      throw new Error("config failed");
    });
    await expect(configureSecret(state, config)).rejects.toThrow("config failed");
    expect(state.values.get("secret-plugin")?.value).toEqual({ token: "old" });
  });

  test("failed config compensation surfaces storage errors while its revision is still current", async () => {
    const state = scope.harness({ providers: {}, plugins: ["secret-plugin"] });
    state.values.set("secret-plugin", { revision: 1, value: { token: "old" } });
    const config = configFacade(state, async (mutate) => {
      await mutate(await state.deps.config.read());
      throw new Error("config failed");
    });
    let writes = 0;
    const repository = {
      ...state.deps.repository,
      writePluginSecret(plugin: string, expectedRevision: number | null, value: unknown) {
        writes += 1;
        if (writes === 2) throw new Error("rollback storage failed");
        return state.deps.repository.writePluginSecret(plugin, expectedRevision, value);
      },
    };
    await expect(configureSecret(state, config, repository)).rejects.toThrow("rollback storage failed");
  });
});
