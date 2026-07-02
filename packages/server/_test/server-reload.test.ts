import { describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import { createServerState } from "../src/server-state";

const decoder = new TextDecoder();

const configWithProvider = (id: string, baseUrl: string) => ({
  providers: [
    {
      kind: "api",
      id,
      protocol: ProviderProtocol.OpenAICompatible,
      baseUrl,
      models: [`${id}-model`],
    },
  ],
});

const writeConfig = (path: string, config: unknown): void => {
  writeFileSync(path, `${JSON.stringify(config)}\n`);
};

async function readNextEventText(
  stream: Response,
  timeoutMs = 2_000,
): Promise<string> {
  const reader = stream.body?.getReader();
  if (reader === undefined) {
    throw new Error("dashboard event stream body is missing");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReadableStreamReadResult<Uint8Array>>(
    (_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("timed out waiting for dashboard event")),
        timeoutMs,
      );
    },
  );

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
  test("Given alias collision config reload When reload is requested Then old provider keeps serving", async () => {
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
    const initialConfig = configWithProvider(
      "old-openai",
      `http://127.0.0.1:${upstream.port}`,
    );
    writeConfig(configPath, initialConfig);
    const app = createServer({
      config: initialConfig,
      configPath,
      watchConfig: false,
    });

    try {
      writeConfig(configPath, {
        providers: [
          {
            kind: "api",
            id: "first",
            protocol: ProviderProtocol.OpenAICompatible,
            baseUrl: "https://first.example.com",
            models: [{ alias: "same", id: "first-model" }],
          },
          {
            kind: "api",
            id: "second",
            protocol: ProviderProtocol.OpenAICompatible,
            baseUrl: "https://second.example.com",
            models: [{ alias: "same", id: "second-model" }],
          },
        ],
      });

      // When
      const reload = await app.request("/dashboard/reload", {
        headers: { Origin: "http://127.0.0.1:22079" },
        method: "POST",
      });
      const chat = await app.request("/v1/chat/completions", {
        body: JSON.stringify({
          model: "old-openai-model",
          messages: [{ role: "user", content: "still there" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await chat.json();

      // Then
      expect(reload.status).toBe(409);
      expect(chat.status).toBe(208);
      expect(body).toEqual({ servedBy: "old-openai" });
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
    const state = createServerState({ config: initialConfig, configPath });
    const stream = new Response(state.events.stream());

    try {
      // When
      writeConfig(configPath, nextConfig);
      const eventText = await readNextEventText(stream);
      const providers = await state.providerSummaries({ probe: false });

      // Then
      expect(eventText).toContain("event: config.changed");
      expect(providers.map((provider) => provider.id)).toEqual(["new-openai"]);
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
    const middleConfig = configWithProvider(
      "middle-openai",
      "https://middle.test",
    );
    const nextConfig = configWithProvider("new-openai", "https://new.test");
    writeConfig(configPath, initialConfig);
    const state = createServerState({ config: initialConfig, configPath });

    try {
      // When
      const firstStream = new Response(state.events.stream());
      writeConfig(tempPath, middleConfig);
      renameSync(tempPath, configPath);
      const firstEventText = await readNextEventText(firstStream);
      const middleProviders = await state.providerSummaries({ probe: false });

      const secondStream = new Response(state.events.stream());
      writeConfig(tempPath, nextConfig);
      renameSync(tempPath, configPath);
      const secondEventText = await readNextEventText(secondStream);
      const nextProviders = await state.providerSummaries({ probe: false });

      // Then
      expect(firstEventText).toContain("event: config.changed");
      expect(middleProviders.map((provider) => provider.id)).toEqual([
        "middle-openai",
      ]);
      expect(secondEventText).toContain("event: config.changed");
      expect(nextProviders.map((provider) => provider.id)).toEqual([
        "new-openai",
      ]);
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
