import { describe, expect, test } from "bun:test";
import { openAICompletionsAdapter } from "@aio-proxy/core";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { handleProtocolRequest } from "../src/routes/pipeline";
import { attemptsOf, MAX_BODY_BYTES, pipeline } from "./pipeline.test-support";
import {
  defineProtocolAdapter,
  defineProviderRouteSource,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
  textStream,
} from "./pipeline-helpers";

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
});
