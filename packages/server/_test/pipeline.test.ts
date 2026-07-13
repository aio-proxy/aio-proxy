import { describe, expect, test } from "bun:test";
import { openAICompletionsAdapter } from "@aio-proxy/core";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { handleProtocolRequest } from "../src/routes/pipeline";
import type { UsageCompletion } from "../src/usage-capture";
import {
  cancellableTextStream,
  createProtocolContext,
  defineProtocolAdapter,
  defineProviderRouteSource,
  emptyStream,
  errorStream,
  type FakeProvider,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
  textStream,
  textThenErrorStream,
} from "./pipeline-helpers";

const MAX_BODY_BYTES = 8 * 1_024 * 1_024;

function pipeline(
  fixtures: readonly FakeProvider[],
  options: {
    readonly adapter?: ReturnType<typeof defineProtocolAdapter>;
    readonly immediateStreamCompletion?: UsageCompletion;
  } = {},
) {
  const adapter = options.adapter ?? defineProtocolAdapter();
  const context = createProtocolContext();
  const route = defineProviderRouteSource(fixtures, options.immediateStreamCompletion);
  return {
    ...route,
    adapter,
    context,
    run: (rawRequest: Request) => handleProtocolRequest({ adapter, context, rawRequest, source: route.source }),
  };
}

function attemptsOf(recording: ReturnType<typeof defineProviderRouteSource>["recording"]) {
  return recording.attempts.map(({ outcome, providerId, statusCode }) => ({ outcome, providerId, statusCode }));
}

describe("shared protocol routing pipeline", () => {
  test("rejects Content-Length above 8 MiB before parse, recording, or provider dispatch", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest("{", { contentLength: MAX_BODY_BYTES + 1 }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "too_large", message: "Request body too large" } });
    expect(harness.context.parseCalls).toBe(0);
    expect(harness.recording.begins).toEqual([]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("rejects malformed Content-Length before parse, recording, or provider dispatch", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }, { contentLength: "invalid" }));

    expect(response.status).toBe(413);
    expect(harness.context.parseCalls).toBe(0);
    expect(harness.recording.begins).toEqual([]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("rejects a chunked body above 8 MiB before recording or provider dispatch", async () => {
    const provider = rawProvider({ id: "raw", modelId: REQUESTED_MODEL });
    const route = defineProviderRouteSource([provider]);
    let chunks = 0;
    const response = await handleProtocolRequest({
      adapter: openAICompletionsAdapter,
      context: {},
      rawRequest: new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks += 1;
            controller.enqueue(new Uint8Array(1_024 * 1_024));
            if (chunks === 9) controller.close();
          },
        }),
      }),
      source: route.source,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "request_too_large" } });
    expect(route.recording.begins).toEqual([]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("maps parse errors without beginning a provider attempt", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest("{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "request_error", message: "Invalid test request" } });
    expect(harness.recording.begins).toEqual([]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("maps model-not-found without beginning a provider attempt", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: "missing" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "model_not_found", message: expect.stringContaining("missing") },
    });
    expect(harness.recording.begins).toEqual([]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("prefers same-protocol raw capability when the provider also has model capability", async () => {
    const provider = rawProvider({
      id: "hybrid",
      invoke: async () => Response.json({ transport: "raw" }),
      model: { invoke: () => textStream("model") },
    });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ transport: "raw" });
    expect(provider.calls.raw).toHaveLength(1);
    expect(provider.calls.model).toHaveLength(0);
    expect(harness.context.modelInvocationCalls).toBe(0);
    expect(harness.usage.passthrough).toHaveLength(1);
    expect(harness.usage.stream).toHaveLength(0);
    expect(attemptsOf(harness.recording)).toEqual([{ outcome: "success", providerId: "hybrid", statusCode: 200 }]);
    expect(harness.recording.begins).toEqual([
      { inboundProtocol: ProviderProtocol.OpenAICompatible, requestedModelId: REQUESTED_MODEL },
    ]);
    expect(harness.recording.attempts[0]).toEqual(
      expect.objectContaining({
        durationMs: expect.any(Number),
        modelId: "hybrid-model",
        providerKind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAICompatible,
      }),
    );
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({
        finalModelId: "hybrid-model",
        finalProviderId: "hybrid",
        finalStatusCode: 200,
        outcome: "success",
      }),
    );
  });

  test("uses model capability when raw protocol differs from the inbound protocol", async () => {
    const provider = rawProvider({
      id: "hybrid",
      protocol: ProviderProtocol.Anthropic,
      invoke: async () => Response.json({ transport: "raw" }),
      model: { invoke: () => textStream("model") },
    });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ output: "model" });
    expect(provider.calls.raw).toHaveLength(0);
    expect(provider.calls.model).toHaveLength(1);
    expect(harness.context.modelInvocationCalls).toBe(1);
    expect(harness.usage.passthrough).toHaveLength(0);
    expect(harness.usage.stream).toHaveLength(1);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "hybrid", outcome: "success" }),
    );
  });

  test("records the selected candidate when model invocation rejects the request", async () => {
    const primary = modelProvider({ id: "primary", invoke: () => textStream("unused") });
    const backup = modelProvider({ id: "backup", invoke: () => textStream("unused") });
    const adapter = defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
      modelInvocationError: new SyntaxError("invalid invocation"),
    });
    const harness = pipeline([primary, backup], { adapter });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(response.status).toBe(400);
    expect(primary.calls.model).toHaveLength(0);
    expect(backup.calls.model).toHaveLength(0);
    expect(harness.recording.finals).toEqual([
      expect.objectContaining({
        finalModelId: "primary-model",
        finalProviderId: "primary",
        finalStatusCode: 400,
        outcome: "failure",
        attempt: expect.objectContaining({
          modelId: "primary-model",
          outcome: "failure",
          providerId: "primary",
          statusCode: 400,
        }),
      }),
    ]);
  });

  test.each([false, true])("passes the resolved model to %s model egress", async (stream) => {
    const egress: unknown[] = [];
    const provider = modelProvider({ id: "model", invoke: () => textStream("model") });
    const adapter = defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
      onModelEgress: (value) => egress.push(value),
    });
    const harness = pipeline([provider], { adapter });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream }));
    await response.body?.cancel();

    expect(egress).toEqual([{ modelId: "model-model" }]);
  });

  test.each([429, 503])("falls back after raw status %d", async (status) => {
    const primary = rawProvider({
      id: "primary",
      invoke: async () => Response.json({ provider: "primary" }, { status }),
    });
    const backup = rawProvider({
      id: "backup",
      invoke: async () => Response.json({ provider: "backup" }),
    });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: status },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "backup", outcome: "success" }),
    );
  });

  test("cancels a raw fallback body even when cleanup rejects", async () => {
    let cancelCalls = 0;
    const primary = rawProvider({
      id: "primary",
      invoke: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelCalls += 1;
              throw new Error("cleanup failed");
            },
          }),
          { status: 503 },
        ),
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(cancelCalls).toBe(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 503 },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
  });

  test("does not fall back after an ordinary raw 400 response", async () => {
    const primary = rawProvider({
      id: "primary",
      invoke: async () => Response.json({ provider: "primary" }, { status: 400 }),
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ provider: "primary" });
    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(0);
    expect(attemptsOf(harness.recording)).toEqual([{ outcome: "failure", providerId: "primary", statusCode: 400 }]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "primary", finalStatusCode: 400, outcome: "failure" }),
    );
  });

  test("falls back after a raw network throw", async () => {
    const primary = rawProvider({
      id: "primary",
      invoke: async () => {
        throw new Error("network down");
      },
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 502 },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
  });

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

  test("records inbound abort as cancelled and does not fall back", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new Error("client aborted");
    abortError.name = "AbortError";
    const primary = rawProvider({
      id: "primary",
      invoke: async () => {
        throw abortError;
      },
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }, { signal: controller.signal }));

    expect(response.status).toBe(502);
    expect(backup.calls.raw).toHaveLength(0);
    expect(attemptsOf(harness.recording)).toEqual([{ outcome: "cancelled", providerId: "primary", statusCode: 502 }]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "primary", outcome: "cancelled" }),
    );
  });

  test("records an unsupported candidate and continues to the next provider", async () => {
    const unsupported = rawProvider({ id: "unsupported", protocol: ProviderProtocol.Anthropic });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([unsupported, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(unsupported.calls.raw).toHaveLength(0);
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "unsupported", statusCode: 501 },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
  });

  test("returns and records the final failure after every candidate fails", async () => {
    const primary = rawProvider({
      id: "primary",
      invoke: async () => Response.json({ provider: "primary" }, { status: 503 }),
    });
    const final = rawProvider({
      id: "final",
      invoke: async () => Response.json({ provider: "final" }, { status: 429 }),
    });
    const harness = pipeline([primary, final]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ provider: "final" });
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 503 },
      { outcome: "failure", providerId: "final", statusCode: 429 },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "final", finalStatusCode: 429, outcome: "failure" }),
    );
  });

  test("rethrows an unknown provider value without calling the next candidate", async () => {
    const unknown = { source: "provider" };
    const primary = rawProvider({
      id: "primary",
      invoke: async () => {
        throw unknown;
      },
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL }))).rejects.toBe(unknown);

    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(0);
    expect(harness.recording.begins).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: undefined },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalModelId: "primary-model", finalProviderId: "primary", outcome: "failure" }),
    );
  });
});
