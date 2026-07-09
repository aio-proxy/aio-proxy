import { describe, expect, test } from "bun:test";
import type { OpenRouterPriceCatalog, TextStreamPart, ToolSet } from "@aio-proxy/core";
import { emptyUsageSummary, type UsageLedger, type UsageLedgerInsert } from "@aio-proxy/core/db";
import { createUsageRecorder } from "../src/usage-recorder";

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

async function drain(stream: ReadableStream<TextStreamPart<ToolSet>>): Promise<void> {
  for await (const _part of stream) {
  }
}

async function waitForRows(rows: readonly UsageLedgerInsert[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (rows.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForPricedRow(rows: readonly UsageLedgerInsert[]): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (rows[0]?.priceModelId !== undefined) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function fakeLedger(rows: UsageLedgerInsert[]): UsageLedger {
  return {
    insert(row) {
      rows.push(row);
    },
    list() {
      return rows;
    },
    summary() {
      return emptyUsageSummary();
    },
    updateCost(id, cost) {
      const index = rows.findIndex((row) => row.id === id);
      const row = rows[index];
      if (row !== undefined) {
        rows[index] = { ...row, ...cost };
      }
    },
  };
}

describe("usage recorder", () => {
  test("writes stream finish usage with estimated cost", async () => {
    const rows: UsageLedgerInsert[] = [];
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "openai/gpt-5.5", input: 2, output: 10 }),
    };
    const recorder = createUsageRecorder({
      ledger: fakeLedger(rows),
      priceCatalogTask: async () => catalog,
    });

    await drain(
      recorder.recordStreamUsage({
        providerId: "openrouter",
        modelId: "gpt-5.5",
        traceId: "trace-1",
        stream: textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "ok" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: {
              inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: undefined },
              inputTokens: 1_000_000,
              outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
              outputTokens: 500_000,
              totalTokens: 1_500_000,
            },
          },
        ]),
      }),
    );
    await waitForRows(rows, 1);
    await waitForPricedRow(rows);

    expect(rows).toEqual([
      {
        id: rows[0]?.id,
        traceId: "trace-1",
        providerId: "openrouter",
        modelId: "gpt-5.5",
        priceModelId: "openai/gpt-5.5",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        totalTokens: 1_500_000,
        estimatedCostUsd: 7,
        createdAt: rows[0]?.createdAt,
      },
    ]);
  });

  test("skips stream without usage", async () => {
    const rows: UsageLedgerInsert[] = [];
    const recorder = createUsageRecorder({
      ledger: fakeLedger(rows),
      priceCatalogTask: async () => undefined,
    });

    await drain(
      recorder.recordStreamUsage({
        providerId: "openrouter",
        modelId: "gpt-5.5",
        traceId: "trace-1",
        stream: textStream([{ type: "text-start", id: "text-1" }]),
      }),
    );

    expect(rows).toEqual([]);
  });

  test("records token usage when price lookup fails", async () => {
    const rows: UsageLedgerInsert[] = [];
    const recorder = createUsageRecorder({
      ledger: fakeLedger(rows),
      priceCatalogTask: async () => undefined,
    });

    await drain(
      recorder.recordStreamUsage({
        providerId: "openrouter",
        modelId: "gpt-5.5",
        traceId: "trace-1",
        stream: textStream([
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: {
              inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: undefined },
              inputTokens: 1,
              outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
              outputTokens: 2,
              totalTokens: 3,
            },
          },
        ]),
      }),
    );
    await waitForRows(rows, 1);

    expect(rows[0]).toEqual({
      id: rows[0]?.id,
      traceId: "trace-1",
      providerId: "openrouter",
      modelId: "gpt-5.5",
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      createdAt: rows[0]?.createdAt,
    });
  });
});
