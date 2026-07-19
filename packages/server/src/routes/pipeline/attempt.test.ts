import { expect, test } from "bun:test";
import { openAIResponsesAdapter } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import {
  defineProviderRouteSource,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
  textStream,
} from "../../../_test/pipeline-helpers";
import { handleProtocolRequest } from ".";

test("skips a model candidate that cannot represent reasoning and continues to raw", async () => {
  const model = modelProvider({ id: "model", invoke: () => textStream("not called") });
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

  expect(await response.json()).toEqual({ provider: "raw" });
  expect(model.calls.model).toHaveLength(0);
  expect(raw.calls.raw).toHaveLength(1);
  expect(
    route.recording.attempts.map(({ errorCode, outcome, providerId, statusCode }) => ({
      errorCode,
      outcome,
      providerId,
      statusCode,
    })),
  ).toEqual([
    { errorCode: "unsupported_feature", outcome: "failure", providerId: "model", statusCode: 501 },
    { errorCode: undefined, outcome: "success", providerId: "raw", statusCode: 200 },
  ]);
});

test("materializes one unsupported conversion across model-only candidates", async () => {
  const first = modelProvider({ id: "first", invoke: () => textStream("not called") });
  const second = modelProvider({ id: "second", invoke: () => textStream("not called") });
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
  expect(
    route.recording.attempts.map(({ errorCode, providerId, statusCode }) => ({ errorCode, providerId, statusCode })),
  ).toEqual([
    { errorCode: "unsupported_feature", providerId: "first", statusCode: 501 },
    { errorCode: "unsupported_feature", providerId: "second", statusCode: 501 },
  ]);
  expect(route.recording.finals[0]).toEqual(expect.objectContaining({ errorCode: "unsupported_feature" }));
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
