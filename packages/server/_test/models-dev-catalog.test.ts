import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextStreamPart, ToolSet } from "@aio-proxy/core";
import { ConfigSchema } from "@aio-proxy/types";
import { createModelsDevCatalogTask, createServerState } from "../src/server-state";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

test("model listing and usage pricing share one cached models.dev fetch", async () => {
  let fetches = 0;
  const state = createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    dbHome: tempHome(),
    modelsDevCatalogTask: createModelsDevCatalogTask(async () => {
      fetches += 1;
      return {
        openai: { models: { "gpt-5.5": { id: "gpt-5.5", name: "GPT-5.5" } } },
        openrouter: {
          models: {
            "openai/gpt-5.5": {
              id: "openai/gpt-5.5",
              name: "GPT-5.5",
              cost: { input: 2, output: 10 },
            },
          },
        },
      };
    }),
  });

  try {
    expect((await state.modelsDevCatalog())?.displayName("gpt-5.5")).toBe("GPT-5.5");
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
