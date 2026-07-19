import { describe, expect, test } from "bun:test";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import {
  defineProtocolAdapter,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
  textStream,
} from "../../../_test/pipeline-helpers";
import { attemptsOf, MAX_BODY_BYTES, pipeline } from "./test-support";

describe("shared protocol routing pipeline", () => {
  test("rejects Content-Length above 64 MiB before parse or provider dispatch", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest("{", { contentLength: MAX_BODY_BYTES + 1 }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "too_large", message: "Request body too large" } });
    expect(harness.context.parseCalls).toBe(0);
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("accepts Content-Length at the 64 MiB boundary", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }, { contentLength: MAX_BODY_BYTES }));

    expect(response.status).toBe(200);
    expect(harness.context.parseCalls).toBe(1);
    expect(provider.calls.raw).toHaveLength(1);
  });

  test("rejects malformed Content-Length before parse or provider dispatch", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }, { contentLength: "invalid" }));

    expect(response.status).toBe(413);
    expect(harness.context.parseCalls).toBe(0);
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("maps parse errors without beginning a provider attempt", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest("{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "request_error", message: "Invalid test request" } });
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
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
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.identities).toEqual([{ requestedModelId: "missing" }]);
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
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.identities).toEqual([{ requestedModelId: REQUESTED_MODEL }]);
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
        errorCode: "invalid_request",
        finalModelId: "primary-model",
        finalProviderId: "primary",
        finalStatusCode: 400,
        outcome: "failure",
        attempt: expect.objectContaining({
          errorCode: "invalid_request",
          modelId: "primary-model",
          outcome: "failure",
          providerId: "primary",
          statusCode: 400,
        }),
      }),
    ]);
    expect(harness.logs).toEqual([
      {
        event: "request.rejected",
        requestId: "request-1",
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        requestedModelId: REQUESTED_MODEL,
        path: "/v1/test",
        statusCode: 400,
        errorCode: "invalid_request",
        errorType: "SyntaxError",
      },
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
