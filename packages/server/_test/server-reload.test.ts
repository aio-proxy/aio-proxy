import { describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicConfigFile, createPluginRepository, type PluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { ConfigSchema, ProviderProtocol } from "@aio-proxy/types";
import { createServerState } from "../src/server-state";

const decoder = new TextDecoder();

const configWithProvider = (id: string, baseURL: string) => ({
  providers: {
    [id]: {
      kind: "api",
      protocol: ProviderProtocol.OpenAICompatible,
      baseURL,
      models: [`${id}-model`],
      alias: { [`${id}-model`]: { model: `${id}-model`, preserve: false } },
    },
  },
});

const writeConfig = (path: string, config: unknown): void => {
  writeFileSync(path, `${JSON.stringify(config)}\n`);
};

const settleWatcher = () => Bun.sleep(50);

function seedOAuthAccount(repository: PluginRepository): void {
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "person@example.com",
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog: {
        kind: "replace",
        value: {
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: 1,
        },
      },
    },
  });
  repository.completeAccountOperation(operation.operationId);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

async function waitForProviderIds(
  state: ReturnType<typeof createServerState>,
  expectedIds: readonly string[],
  timeoutMs = 2_000,
): Promise<readonly string[]> {
  const deadline = performance.now() + timeoutMs;
  let ids: readonly string[] = [];
  while (performance.now() < deadline) {
    const providers = await state.providerSummaries({ probe: false });
    ids = providers.map((provider) => provider.id);
    if (sameIds(ids, expectedIds)) {
      return ids;
    }
    await Bun.sleep(10);
  }
  return ids;
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

async function readNextEventText(stream: Response, timeoutMs = 2_000): Promise<string> {
  const reader = stream.body?.getReader();
  if (reader === undefined) {
    throw new Error("dashboard event stream body is missing");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out waiting for dashboard event")), timeoutMs);
  });

  try {
    const chunk = await Promise.race([reader.read(), deadline]);
    return chunk.done ? "" : decoder.decode(chunk.value);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel();
  }
}

describe("server reload", () => {
  test("an uncertain reload commit keeps cleanup recoverable after the snapshot swaps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-reload-uncertain-"));
    const configPath = join(dir, "config.json");
    const initialConfig = {
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    };
    writeConfig(configPath, initialConfig);
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    seedOAuthAccount(repository);
    const committedFile = new AtomicConfigFile(configPath);
    let transactions = 0;
    const uncertainFile = {
      async transaction<T>(
        mutate: Parameters<AtomicConfigFile["transaction"]>[0],
        options: Parameters<AtomicConfigFile["transaction"]>[1] = {},
      ): Promise<T> {
        transactions++;
        if (transactions <= 2) return committedFile.transaction(mutate, options) as Promise<T>;
        await mutate(await committedFile.read());
        throw new Error("Config lock ownership lost");
      },
    } as AtomicConfigFile;
    const state = await createServerState({
      config: ConfigSchema.parse(initialConfig),
      configPath,
      pluginRepository: repository,
      watchConfig: false,
      logger: () => {},
      __test: { configFile: uncertainFile },
    } as never);

    try {
      writeConfig(configPath, { providers: {} });
      expect(await state.reload()).toMatchObject({ ok: false });
      expect(await state.providerSummaries({ probe: false })).toEqual([]);
      await waitUntil(() => repository.readAccount("person") === null);
      expect(repository.listPendingAccountOperations()).toEqual([]);
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["manual reload", false, { kind: "oauth", plugin: "@example/oauth", capability: "" }],
    ["watcher reload", true, { kind: "oauth", vendor: "legacy-provider" }],
  ])("Given an invalid or legacy OAuth row When %s removes it Then account cleanup uses a CAS marker", async (_label, watchConfig, provider) => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-reload-oauth-delete-"));
    const configPath = join(dir, "config.jsonc");
    const initialConfig = { providers: { person: provider } };
    writeConfig(configPath, initialConfig);
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    seedOAuthAccount(repository);
    const state = await createServerState({
      config: ConfigSchema.parse(initialConfig),
      configPath,
      pluginRepository: repository,
      watchConfig,
      logger: () => {},
    });

    try {
      if (watchConfig) await settleWatcher();
      writeConfig(configPath, { providers: {} });
      if (watchConfig) {
        await waitUntil(() => repository.readAccount("person") === null);
      } else {
        expect(await state.reload()).toMatchObject({ ok: true });
        await waitUntil(() => repository.readAccount("person") === null);
      }

      expect(repository.readAccount("person")).toBeNull();
      expect(repository.listPendingAccountOperations()).toEqual([]);
      expect(await state.reload()).toMatchObject({ ok: true });
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Given invalid provider config reload When reload is requested Then the provider degrades independently", async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-reload-"));
    const configPath = join(dir, "config.jsonc");
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ servedBy: "old-openai" }, { status: 208 });
      },
    });
    const initialConfig = configWithProvider("old-openai", `http://127.0.0.1:${upstream.port}`);
    writeConfig(configPath, initialConfig);
    const app = await createServer({
      config: initialConfig,
      configPath,
      watchConfig: false,
    });

    try {
      writeConfig(configPath, {
        providers: {
          duplicate: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: "https://duplicate.example.com",
            models: ["first-model", "second-model"],
            alias: {
              "first-model": { model: "second-model", preserve: false },
              firstAlias: { model: "first-model", preserve: true },
            },
          },
        },
      });

      // When
      const reload = await app.request("/dashboard/api/reload", {
        headers: { Origin: "http://127.0.0.1:22078" },
        method: "POST",
      });
      const providers = await app.request("/dashboard/api/providers/duplicate");
      const body = await providers.json();

      // Then
      expect(reload.status).toBe(200);
      expect(providers.status).toBe(200);
      expect(body.provider).toMatchObject({ id: "duplicate", enabled: false, clientModels: [] });
    } finally {
      await upstream.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Given direct config write When watcher observes file Then providers reload", async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-watch-write-"));
    const configPath = join(dir, "config.jsonc");
    const initialConfig = configWithProvider("old-openai", "https://old.test");
    const nextConfig = configWithProvider("new-openai", "https://new.test");
    writeConfig(configPath, initialConfig);
    const state = await createServerState({ config: ConfigSchema.parse(initialConfig), configPath });
    const stream = new Response(state.events.stream());

    try {
      // When
      await settleWatcher();
      writeConfig(configPath, nextConfig);
      const eventText = await readNextEventText(stream);
      const providerIds = await waitForProviderIds(state, ["new-openai"]);

      // Then
      expect(eventText).toContain("event: config.changed");
      expect(providerIds).toEqual(["new-openai"]);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Given repeated atomic config replacement When watcher observes renames Then providers reload each time", async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-watch-rename-"));
    const configPath = join(dir, "config.jsonc");
    const tempPath = join(dir, "config.jsonc.tmp");
    const initialConfig = configWithProvider("old-openai", "https://old.test");
    const middleConfig = configWithProvider("middle-openai", "https://middle.test");
    const nextConfig = configWithProvider("new-openai", "https://new.test");
    writeConfig(configPath, initialConfig);
    const state = await createServerState({ config: ConfigSchema.parse(initialConfig), configPath });

    try {
      // When
      await settleWatcher();
      const firstStream = new Response(state.events.stream());
      writeConfig(tempPath, middleConfig);
      renameSync(tempPath, configPath);
      const firstEventText = await readNextEventText(firstStream);
      const middleProviderIds = await waitForProviderIds(state, ["middle-openai"]);

      const secondStream = new Response(state.events.stream());
      writeConfig(tempPath, nextConfig);
      renameSync(tempPath, configPath);
      const secondEventText = await readNextEventText(secondStream);
      const nextProviderIds = await waitForProviderIds(state, ["new-openai"]);

      // Then
      expect(firstEventText).toContain("event: config.changed");
      expect(middleProviderIds).toEqual(["middle-openai"]);
      expect(secondEventText).toContain("event: config.changed");
      expect(nextProviderIds).toEqual(["new-openai"]);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
