import { describe, expect, test } from "bun:test";
import { openAICompletionsAdapter } from "@aio-proxy/core";
import { handleProtocolRequest } from "../src/routes/pipeline";
import { attemptsOf, pipeline } from "./pipeline.test-support";
import {
  cancellableTextStream,
  defineProtocolAdapter,
  defineProviderRouteSource,
  emptyStream,
  errorStream,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  settleRecording,
  textStream,
  textThenErrorStream,
} from "./pipeline-helpers";

describe("shared protocol routing pipeline", () => {
  test.each([
    "ensure",
    "invoke",
    "first-event",
    "json",
  ] as const)("falls back when model %s fails before the response is committed", async (stage) => {
    const error = new Error(`${stage} failed`);
    const primary = modelProvider({
      id: "primary",
      ...(stage === "ensure"
        ? {
            ensureAvailable: async () => {
              throw error;
            },
          }
        : {}),
      invoke: () => {
        if (stage === "invoke") throw error;
        if (stage === "first-event") return errorStream(error);
        if (stage === "json") return textThenErrorStream("partial", error);
        return textStream("unused");
      },
    });
    const backup = modelProvider({ id: "backup", invoke: () => textStream("fallback") });
    const harness = pipeline([primary, backup]);
    const stream = stage === "first-event";

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream }));
    await settleRecording();

    if (stream) {
      expect(await response.text()).toContain("fallback");
    } else {
      expect(await response.json()).toEqual({ output: "fallback" });
    }
    expect(primary.calls.model).toHaveLength(stage === "ensure" ? 0 : 1);
    expect(backup.calls.model).toHaveLength(1);
    expect(harness.context.modelInvocationCalls).toBe(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 502 },
      { outcome: "success", providerId: "backup", statusCode: undefined },
    ]);
    if (stage === "first-event") {
      expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
    }
  });

  test("does not let immediate completion win when the SSE writer throws before commit", async () => {
    const writerError = new Error("writer failed");
    const base = defineProtocolAdapter();
    let writerCalls = 0;
    const adapter = {
      ...base,
      modelSse(stream: Parameters<typeof base.modelSse>[0]) {
        writerCalls += 1;
        if (writerCalls === 1) throw writerError;
        return base.modelSse(stream);
      },
    } satisfies typeof base;
    const primary = modelProvider({ id: "primary", invoke: () => textStream("primary") });
    const backup = modelProvider({ id: "backup", invoke: () => textStream("backup") });
    const harness = pipeline([primary, backup], {
      adapter,
      immediateStreamCompletion: { outcome: "success" },
    });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    expect(await response.text()).toContain("backup");
    await settleRecording();

    expect(writerCalls).toBe(2);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 502 },
      { outcome: "success", providerId: "backup", statusCode: undefined },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "backup", outcome: "success" }),
    );
    expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
  });

  test("does not let immediate completion win when JSON serialization throws before commit", async () => {
    const base = defineProtocolAdapter();
    let jsonCalls = 0;
    const adapter = {
      ...base,
      async modelJson(stream: Parameters<typeof base.modelJson>[0]) {
        jsonCalls += 1;
        if (jsonCalls === 1) return { value: 1n };
        return base.modelJson(stream);
      },
    } satisfies typeof base;
    const primary = modelProvider({ id: "primary", invoke: () => textStream("primary") });
    const backup = modelProvider({ id: "backup", invoke: () => textStream("backup") });
    const harness = pipeline([primary, backup], {
      adapter,
      immediateStreamCompletion: { outcome: "success" },
    });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    expect(await response.json()).toEqual({ output: "backup" });
    await settleRecording();

    expect(jsonCalls).toBe(2);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 502 },
      { outcome: "success", providerId: "backup", statusCode: undefined },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "backup", outcome: "success" }),
    );
  });

  test("treats an empty model stream as pre-commit failure and releases both readers", async () => {
    const primary = modelProvider({ id: "primary", invoke: emptyStream });
    const backup = modelProvider({ id: "backup", invoke: () => textStream("backup") });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    expect(await response.text()).toContain("backup");
    await settleRecording();

    expect(primary.calls.model).toHaveLength(1);
    expect(backup.calls.model).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 502 },
      { outcome: "success", providerId: "backup", statusCode: undefined },
    ]);
    expect(harness.usage.capturedStreams.every((stream) => !stream.locked)).toBe(true);
  });

  test("exposes a model stream error after the first event without trying the next candidate", async () => {
    const streamError = new Error("after first event");
    const primary = modelProvider({
      id: "primary",
      invoke: () => textThenErrorStream("partial", streamError),
    });
    const backup = modelProvider({ id: "backup", invoke: () => textStream("fallback") });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));

    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    await expect(response.text()).rejects.toThrow("after first event");
    await settleRecording();
    expect(primary.calls.model).toHaveLength(1);
    expect(backup.calls.model).toHaveLength(0);
    expect(harness.context.modelInvocationCalls).toBe(1);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "primary", outcome: "failure" }),
    );
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: undefined },
    ]);
    expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
  });

  test("releases the preflight reader after a successful stream reaches EOF", async () => {
    const provider = modelProvider({ id: "provider", invoke: () => textStream("done") });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    expect(await response.text()).toContain("done");
    await settleRecording();

    expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "provider", outcome: "success" }),
    );
  });

  test("releases the preflight reader when the client cancels", async () => {
    let cancelCalls = 0;
    const provider = modelProvider({
      id: "provider",
      invoke: () =>
        cancellableTextStream("partial", () => {
          cancelCalls += 1;
        }),
    });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel("client stopped");
    await settleRecording();

    expect(cancelCalls).toBe(1);
    expect(harness.usage.capturedStreams[0]?.locked).toBe(false);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "provider", outcome: "failure" }),
    );
  });

  test("cancels the provider model stream through the real protocol egress", async () => {
    let cancelCalls = 0;
    const provider = modelProvider({
      id: "provider",
      invoke: () =>
        cancellableTextStream("partial", () => {
          cancelCalls += 1;
        }),
    });
    const route = defineProviderRouteSource([provider]);
    const response = await handleProtocolRequest({
      adapter: openAICompletionsAdapter,
      context: {},
      rawRequest: new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: REQUESTED_MODEL, messages: [{ role: "user", content: "ping" }], stream: true }),
      }),
      source: route.source,
    });

    const reader = response.body?.getReader();
    expect((await reader?.read())?.done).toBe(false);
    await reader?.cancel("client stopped");
    await settleRecording();

    expect(cancelCalls).toBe(1);
    expect(route.usage.capturedStreams[0]?.locked).toBe(false);
  });
});
