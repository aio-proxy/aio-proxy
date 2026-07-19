import { describe, expect, test } from "bun:test";

import {
  type AioModelMessage,
  type AioStreamPart,
  DashboardEventSchema,
  DashboardUsageOverviewResponseSchema,
  RequestOutcomeSchema,
  TraceEventSchema,
  UsageOverviewGroupBySchema,
  UsageOverviewMetricSchema,
  UsageOverviewRangeSchema,
} from "../src/index";

describe("TraceEventSchema", () => {
  test("roundtrips delta trace events", () => {
    const event = {
      type: "delta",
      traceId: "trace-1",
      timestamp: "2026-06-30T00:00:00.000Z",
      textDelta: "hello",
    };

    expect(TraceEventSchema.parse(event)).toEqual(event);
  });

  test("roundtrips end trace events with usage", () => {
    const event = {
      type: "end",
      traceId: "trace-1",
      timestamp: "2026-06-30T00:00:01.000Z",
      usage: {
        providerId: "openai",
        modelId: "gpt-5-mini",
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
      },
    };

    expect(TraceEventSchema.parse(event)).toEqual(event);
  });

  test("roundtrips usage rows with price and optional token dimensions", () => {
    const event = {
      type: "end",
      traceId: "trace-1",
      timestamp: "2026-07-09T00:00:01.000Z",
      usage: {
        providerId: "openrouter",
        modelId: "gpt-5.5",
        inputTokens: 1000,
        outputTokens: 2000,
        totalTokens: 3000,
        cacheReadTokens: 500,
        cacheWriteTokens: 250,
        reasoningTokens: 100,
        priceModelId: "openai/gpt-5.5",
        estimatedCostUsd: 0.0123,
      },
    };

    expect(TraceEventSchema.parse(event)).toEqual(event);
  });
});

describe("DashboardEventSchema", () => {
  test("roundtrips trace start dashboard events", () => {
    const event = {
      event: "trace.start",
      data: {
        trace_id: "trace-1",
        providerId: "openai",
        modelId: "gpt-5-mini",
      },
    };

    expect(DashboardEventSchema.parse(event)).toEqual(event);
  });

  test("roundtrips trace end dashboard events with usage", () => {
    const event = {
      event: "trace.end",
      data: {
        trace_id: "trace-1",
        usage: {
          providerId: "openai",
          modelId: "gpt-5-mini",
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
        },
      },
    };

    expect(DashboardEventSchema.parse(event)).toEqual(event);
  });
});

test("parses usage overview controls and request outcomes", () => {
  expect(UsageOverviewRangeSchema.parse("24h")).toBe("24h");
  expect(UsageOverviewMetricSchema.parse("cost")).toBe("cost");
  expect(UsageOverviewGroupBySchema.parse("model")).toBe("model");
  expect(RequestOutcomeSchema.parse("cancelled")).toBe("cancelled");
});

test("roundtrips the usage overview response", () => {
  const response = {
    range: "24h",
    metric: "cost",
    groupBy: "model",
    rangeStart: "2026-07-10T08:00:00.000Z",
    rangeEnd: "2026-07-11T08:00:00.000Z",
    bucketUnit: "hour",
    summary: {
      estimatedCostUsd: 1.25,
      pricingCoverage: 0.8,
      pricedRequestCount: 8,
      usageRequestCount: 10,
      requestCount: 12,
      successCount: 10,
      failureCount: 1,
      cancelledCount: 1,
      successRate: 10 / 11,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      averageRpm: 12 / 1440,
      averageTpm: 150 / 1440,
    },
    series: [
      { key: "openai/gpt-5", kind: "dimension" },
      { key: "__other__", kind: "other" },
    ],
    buckets: [
      {
        key: "2026-07-11 08:00",
        values: { "openai/gpt-5": 1.25, __other__: 0 },
      },
    ],
  } as const;

  expect(DashboardUsageOverviewResponseSchema.parse(response)).toEqual(response);
});

const _message: AioModelMessage = { role: "user", content: "hello" };
const _part: AioStreamPart = { type: "text-delta", textDelta: "hi" };
void _message;
void _part;
