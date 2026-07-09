import {
  calculateEstimatedCost,
  type OpenRouterPriceCatalog,
  type TextStreamPart,
  type ToolSet,
} from "@aio-proxy/core";
import type { UsageLedger, UsageLedgerInsert } from "@aio-proxy/core/db";
import type { ProviderProtocol, UsageRow } from "@aio-proxy/types";
import { extractPassthroughUsage } from "./passthrough-usage";

type FinishPart = Extract<TextStreamPart<ToolSet>, { readonly type: "finish" }>;

export type UsageRecorder = {
  readonly recordStreamUsage: (options: StreamUsageOptions) => ReadableStream<TextStreamPart<ToolSet>>;
  readonly recordPassthroughUsage: (options: PassthroughUsageOptions) => Response;
};

export type StreamUsageOptions = {
  readonly stream: ReadableStream<TextStreamPart<ToolSet>>;
  readonly providerId: string;
  readonly modelId: string;
  readonly traceId: string;
};

export type PassthroughUsageOptions = {
  readonly response: Response;
  readonly protocol: ProviderProtocol;
  readonly providerId: string;
  readonly modelId: string;
  readonly traceId: string;
};

export function createUsageRecorder(options: {
  readonly ledger: UsageLedger;
  readonly priceCatalogTask: () => Promise<OpenRouterPriceCatalog | undefined>;
}): UsageRecorder {
  const write = (usage: UsageRow, traceId: string): void => {
    const row = insertRow(usage, traceId);
    options.ledger.insert(row);
    void ignoreAccountingFailure(updatePrice(row.id, usage, options.ledger, options.priceCatalogTask));
  };

  return {
    recordStreamUsage({ stream, providerId, modelId, traceId }) {
      let finishUsage: UsageRow | undefined;
      return new ReadableStream({
        async start(controller) {
          try {
            for await (const part of stream) {
              if (part.type === "finish") {
                finishUsage = normalizeAiSdkUsage(part, providerId, modelId);
              }
              controller.enqueue(part);
            }
            const usage = finishUsage;
            if (usage !== undefined) {
              void ignoreAccountingFailure(Promise.resolve().then(() => write(usage, traceId)));
            }
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
    },
    recordPassthroughUsage({ response, protocol, providerId, modelId, traceId }) {
      if (response.body === null || !response.ok) {
        return response;
      }
      const [returnedBody, tracedBody] = response.body.tee();
      void ignoreAccountingFailure(
        new Response(tracedBody)
          .text()
          .then((bodyText) => extractPassthroughUsage(protocol, bodyText))
          .then((usage) => {
            if (usage !== undefined) {
              write({ ...usage, providerId, modelId }, traceId);
            }
          }),
      );
      return new Response(returnedBody, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    },
  };
}

function normalizeAiSdkUsage(part: FinishPart, providerId: string, modelId: string): UsageRow | undefined {
  const usage = part.totalUsage;
  if (Object.keys(usage).length === 0) {
    return undefined;
  }
  return {
    providerId,
    modelId,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.inputTokenDetails?.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: usage.inputTokenDetails.cacheReadTokens }),
    ...(usage.inputTokenDetails?.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens }),
    ...(usage.outputTokenDetails?.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.outputTokenDetails.reasoningTokens }),
  };
}

async function updatePrice(
  rowId: string,
  usage: UsageRow,
  ledger: UsageLedger,
  priceCatalogTask: () => Promise<OpenRouterPriceCatalog | undefined>,
): Promise<void> {
  const catalog = await priceCatalogTask();
  const price = catalog?.find(usage.modelId);
  if (price === undefined) {
    return;
  }
  const cost = calculateEstimatedCost(pricingInput(usage), price);
  if (cost !== undefined) {
    ledger.updateCost(rowId, cost);
  }
}

function pricingInput(usage: UsageRow) {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  };
}

function insertRow(usage: UsageRow, traceId: string): UsageLedgerInsert {
  return {
    id: crypto.randomUUID(),
    traceId,
    providerId: usage.providerId,
    modelId: usage.modelId,
    ...(usage.priceModelId === undefined ? {} : { priceModelId: usage.priceModelId }),
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: usage.estimatedCostUsd }),
    createdAt: new Date(),
  };
}

async function ignoreAccountingFailure(task: Promise<unknown>): Promise<void> {
  try {
    await task;
  } catch (error) {
    if (error instanceof Error) {
      return;
    }
    throw error;
  }
}
