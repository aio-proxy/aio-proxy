import type { FetchModelsDevProviders, TextStreamPart, ToolSet } from "@aio-proxy/core";

import { ConfigSchema } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createModelsDevCatalogTask, createServerState } from "../src/server-state";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

test("model listing and usage pricing share one cached models.dev fetch", async () => {
  let fetches = 0;
  const providers = {
    openrouter: {
      doc: "https://openrouter.ai/models",
      env: ["OPENROUTER_API_KEY"],
      id: "openrouter",
      models: {
        "openai/gpt-5.5": {
          attachment: true,
          cost: { input: 2, output: 10 },
          description: "",
          id: "openai/gpt-5.5",
          last_updated: "2026-01-15",
          limit: { context: 128_000, input: 120_000, output: 8_000 },
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
          name: "GPT-5.5",
          open_weights: false,
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
          release_date: "2026-01-15",
          structured_output: true,
          tool_call: true,
        },
      },
      name: "OpenRouter",
      npm: "@openrouter/ai-sdk-provider",
    },
  } satisfies Awaited<ReturnType<FetchModelsDevProviders>>;
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    dbHome: tempHome(),
    modelsDevCatalogTask: createModelsDevCatalogTask(async () => {
      fetches += 1;
      return providers;
    }),
  });

  try {
    expect((await state.modelsDevCatalog())?.metadata("gpt-5.5")).toMatchObject({
      displayName: "GPT-5.5",
      maxInputTokens: 120_000,
      maxTokens: 8_000,
      releaseDate: "2026-01-15",
    });
    const captured = state.usageCapture.stream({
      providerId: "provider",
      modelId: "gpt-5.5",
      stream: textStream([finishPart()]),
    });

    await drain(captured.value);
    await captured.completion;

    expect(fetches).toBe(1);
  } finally {
    state.close();
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-models-dev-"));
  homes.push(home);
  return home;
}

function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function finishPart(): TextStreamPart<ToolSet> {
  return {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 1 },
      inputTokens: 1,
      outputTokenDetails: { reasoningTokens: 0, textTokens: 1 },
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}

async function drain<T>(stream: ReadableStream<T>): Promise<void> {
  for await (const _value of stream) {
    // Drain the stream so usage pricing reaches completion.
  }
}
