import { openAIResponsesAdapter } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import { handleProtocolRequest } from ".";
import {
  defineProviderRouteSource,
  errorStream,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
  textStream,
} from "../../../_test/pipeline-helpers";

test("converts portable reasoning and uses the model candidate", async () => {
  const model = modelProvider({ id: "model", invoke: () => textStream("model response") });
  const raw = rawProvider({ id: "raw", protocol: ProviderProtocol.OpenAIResponse });
  const route = defineProviderRouteSource([model, raw]);
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [{ type: "reasoning", id: "rs_1", summary: [] }],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording();

  expect(await response.json()).toMatchObject({ output_text: "model response", status: "completed" });
  expect(model.calls.model).toHaveLength(1);
  expect(raw.calls.raw).toHaveLength(0);
  expect(
    route.recording.attempts.map(({ errorCode, outcome, providerId, statusCode }) => ({
      errorCode,
      outcome,
      providerId,
      statusCode,
    })),
  ).toEqual([{ errorCode: undefined, outcome: "success", providerId: "model", statusCode: undefined }]);
});

test("rejects an item reference before invoking a model", async () => {
  const first = modelProvider({ id: "first", invoke: () => textStream("model response") });
  const second = modelProvider({ id: "second", invoke: () => textStream("unused") });
  const route = defineProviderRouteSource([first, second]);
  let materializations = 0;
  const adapter = {
    ...openAIResponsesAdapter,
    modelInvocation(
      request: Parameters<typeof openAIResponsesAdapter.modelInvocation>[0],
      context: Parameters<typeof openAIResponsesAdapter.modelInvocation>[1],
    ) {
      materializations += 1;
      return openAIResponsesAdapter.modelInvocation(request, context);
    },
  };
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: REQUESTED_MODEL, input: [{ type: "item_reference", id: "item_1" }] }),
  });

  const response = await handleProtocolRequest({ adapter, context: {}, rawRequest, source: route.source });

  expect(response.status).toBe(501);
  expect(materializations).toBe(1);
  expect(first.calls.model).toHaveLength(0);
  expect(second.calls.model).toHaveLength(0);
  expect(
    route.recording.attempts.map(({ errorCode, outcome, providerId, statusCode }) => ({
      errorCode,
      outcome,
      providerId,
      statusCode,
    })),
  ).toEqual([
    { errorCode: "unsupported_feature", outcome: "failure", providerId: "first", statusCode: 501 },
    { errorCode: "unsupported_feature", outcome: "failure", providerId: "second", statusCode: 501 },
  ]);
  expect(route.recording.finals[0]).toEqual(
    expect.objectContaining({ errorCode: "unsupported_feature", outcome: "failure" }),
  );
});

test("skips a Gemini candidate for a remote tool-result image and invokes the next target", async () => {
  const gemini = modelProvider({
    id: "gemini",
    targetProtocol: ProviderProtocol.Gemini,
    invoke: () => textStream("must not run"),
  });
  const anthropic = modelProvider({
    id: "anthropic",
    targetProtocol: ProviderProtocol.Anthropic,
    invoke: () => textStream("fallback response"),
  });
  const route = defineProviderRouteSource([gemini, anthropic]);
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: "https://example.test/image.png" }],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording();

  expect(response.status).toBe(200);
  expect(gemini.calls.model).toHaveLength(0);
  expect(anthropic.calls.model).toHaveLength(1);
  expect(anthropic.calls.model[0]?.messages[1]).toMatchObject({
    role: "tool",
    content: [
      {
        output: {
          type: "content",
          value: [
            {
              type: "file",
              mediaType: "image",
              data: { type: "url", url: new URL("https://example.test/image.png") },
            },
          ],
        },
      },
    ],
  });
  expect(
    route.recording.attempts.map(({ errorCode, outcome, providerId }) => ({ errorCode, outcome, providerId })),
  ).toEqual([
    { errorCode: "unsupported_feature", outcome: "failure", providerId: "gemini" },
    { errorCode: undefined, outcome: "success", providerId: "anthropic" },
  ]);
});

test("falls back after an OpenAI-compatible endpoint rejects the CPA extension", async () => {
  const compatible = modelProvider({
    id: "compatible",
    targetProtocol: ProviderProtocol.OpenAICompatible,
    invoke: () => errorStream(new Error("compatible endpoint rejected tool image content")),
  });
  const responses = modelProvider({
    id: "responses",
    targetProtocol: ProviderProtocol.OpenAIResponse,
    invoke: () => textStream("fallback response"),
  });
  const route = defineProviderRouteSource([compatible, responses]);
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [
        { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
        },
      ],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });
  await settleRecording();

  expect(response.status).toBe(200);
  expect(compatible.calls.model).toHaveLength(1);
  expect(responses.calls.model).toHaveLength(1);
  expect(route.recording.attempts.map(({ outcome, providerId }) => ({ outcome, providerId }))).toEqual([
    { outcome: "failure", providerId: "compatible" },
    { outcome: "success", providerId: "responses" },
  ]);
});

test("fails fast on invalid function arguments without trying raw", async () => {
  const model = modelProvider({ id: "model", invoke: () => textStream("not called") });
  const raw = rawProvider({ id: "raw", protocol: ProviderProtocol.OpenAIResponse });
  const route = defineProviderRouteSource([model, raw]);
  const rawRequest = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: REQUESTED_MODEL,
      input: [{ type: "function_call", call_id: "call_1", name: "read", arguments: "{" }],
    }),
  });

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest,
    source: route.source,
  });

  expect(response.status).toBe(400);
  expect(raw.calls.raw).toHaveLength(0);
  expect(
    route.recording.attempts.map(({ errorCode, providerId, statusCode }) => ({ errorCode, providerId, statusCode })),
  ).toEqual([{ errorCode: "invalid_request", providerId: "model", statusCode: 400 }]);
  expect(route.recording.finals[0]).toEqual(expect.objectContaining({ errorCode: "invalid_request" }));
});
