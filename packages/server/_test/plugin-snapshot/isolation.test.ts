import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { type CredentialPort, definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema } from "@aio-proxy/types";
import { createServerState } from "../../src/server-state";
import { cleanup, flushMicrotasks, seedOAuthAccount } from "./test-support";

afterEach(cleanup);

test("plugin option identity survives nested in-place schema transforms across snapshot reloads", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-options-identity-"));
  const configPath = join(home, "config.json");
  const input = (value: string) => ({
    plugins: [["@example/oauth", { nested: { value } }]],
    providers: {
      person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
    },
  });
  writeFileSync(configPath, JSON.stringify(input("https://one.example.test")));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  handle.close();
  const setupValues: unknown[] = [];
  let runtimes = 0;
  const descriptor = definePlugin(
    (api, options) => {
      setupValues.push((options as { nested: { value: unknown } }).nested.value);
      api.oauth.register({
        id: "default",
        label: "Example",
        account: { options: { schema: zod.object({}), form: [] } },
        credentials: zod.object({ token: zod.string() }),
        async login() {
          throw new Error("not called");
        },
        catalog: {
          policy: { kind: "static" },
          async discover() {
            throw new Error("stored catalog should be used");
          },
        },
        async createRuntime() {
          runtimes++;
          return {
            provider: {
              specificationVersion: "v4",
              languageModel() {
                throw new Error("not called");
              },
              imageModel() {
                throw new Error("not called");
              },
              embeddingModel() {
                throw new Error("not called");
              },
            },
          } as never;
        },
      });
    },
    {
      options: {
        schema: zod.object({ nested: zod.any() }).transform(({ nested }) => {
          nested.value = new URL(nested.value as string);
          return { nested };
        }),
        form: [],
      },
    },
  );
  const state = await createServerState({
    config: ConfigSchema.parse(input("https://one.example.test")),
    configPath,
    watchConfig: false,
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
  });

  try {
    expect(runtimes).toBe(1);
    expect(setupValues[0]).toBeInstanceOf(URL);

    writeFileSync(configPath, JSON.stringify(input("https://one.example.test")));
    expect(await state.reload()).toMatchObject({ ok: true });
    expect(runtimes).toBe(1);

    writeFileSync(configPath, JSON.stringify(input("https://two.example.test")));
    expect(await state.reload()).toMatchObject({ ok: true });
    expect(runtimes).toBe(2);
    expect(setupValues).toHaveLength(3);
    expect(setupValues.every((value) => value instanceof URL)).toBe(true);
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("credential expiry metadata rebuilds summaries without recreating the runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-credential-summary-"));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  handle.close();
  let credentials: CredentialPort<{ token: string }> | undefined;
  let runtimes = 0;
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example",
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        throw new Error("not called");
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          throw new Error("stored catalog should be used");
        },
      },
      async createRuntime(context) {
        runtimes++;
        credentials = context.credentials;
        return {
          provider: {
            specificationVersion: "v4",
            languageModel() {
              throw new Error("not called");
            },
            imageModel() {
              throw new Error("not called");
            },
            embeddingModel() {
              throw new Error("not called");
            },
          },
        } as never;
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    }),
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
  });

  try {
    if (credentials === undefined) throw new Error("credential port missing");
    const current = await credentials.read();
    await credentials.refresh(current.revision, async () => ({
      value: { token: "rotated" },
      metadata: { expiresAt: 123_456 },
    }));
    await flushMicrotasks();
    await Bun.sleep(0);
    await flushMicrotasks();

    expect((await state.providerSummaries({ probe: false }))[0]?.expiresAt).toBe(123_456);
    expect(runtimes).toBe(1);
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("failed plugin setup remains snapshot data and does not block API or AI SDK providers", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-failed-plugin-isolation-"));
  const descriptor = definePlugin(() => {
    throw new Error("setup failed");
  });
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {
        stable: {
          kind: "api",
          protocol: "openai-compatible",
          baseURL: "https://stable.example.test/v1",
          models: ["stable-model"],
        },
        sdk: {
          kind: "ai-sdk",
          packageName: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://sdk.example.test/v1", name: "sdk" },
          models: ["sdk-model"],
        },
      },
    }),
    dbHome: home,
    builtIns: [{ packageName: "@example/broken", version: "1.0.0", descriptor }],
    pluginLogger: () => {},
  });

  try {
    expect(state.currentProviderSnapshot().plugins.plugins.get("@example/broken")).toMatchObject({
      state: { status: "failed", diagnostic: { code: "PLUGIN_LOAD_FAILED" } },
    });
    expect(state.currentProviderSnapshot().router.resolve("stable-model")[0]?.provider.id).toBe("stable");
    expect(state.currentProviderSnapshot().router.resolve("sdk-model")[0]?.provider.id).toBe("sdk");
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});
