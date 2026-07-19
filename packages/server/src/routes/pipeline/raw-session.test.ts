import { expect, test } from "bun:test";
import { openAIResponsesAdapter } from "@aio-proxy/core";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { ProviderProtocol } from "@aio-proxy/types";
import { defineProviderRouteSource, jsonRequest, REQUESTED_MODEL, rawProvider } from "../../../_test/pipeline-helpers";
import type { ProviderRouteSource } from "../../runtime";
import { createUsageCapture } from "../../usage-capture";
import { handleProtocolRequest } from "./index";

test.each([
  ["JSON", false, JSON.stringify({ id: "resp_raw_json", status: "completed" }), "resp_raw_json"],
  [
    "SSE",
    true,
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_raw_sse","status":"completed"}}\n\n',
    "resp_raw_sse",
  ],
] as const)("commits a completed raw OpenAI Responses %s response", async (_shape, stream, body, responseId) => {
  let logicalRequest: LogicalRequestContext | undefined;
  const provider = rawProvider({
    id: "raw",
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async (_request, context) => {
      logicalRequest = context;
      return new Response(body, {
        headers: { "content-type": stream ? "text/event-stream" : "application/json" },
      });
    },
  });
  const source = realUsageSource(defineProviderRouteSource([provider]).source);

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: jsonRequest({ input: "ping", model: REQUESTED_MODEL, stream }),
    source,
  });
  await response.text();
  const resumed = previous(source, responseId);

  expect(resumed.session).toEqual({ key: logicalRequest?.session.key, source: "previous-response" });
});

test.each([
  ["incomplete JSON", JSON.stringify({ id: "resp_incomplete", status: "incomplete" }), "application/json"],
  [
    "failed SSE",
    'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp_failed","status":"failed"}}\n\n',
    "text/event-stream",
  ],
] as const)("does not commit a raw OpenAI Responses %s response", async (_shape, body, contentType) => {
  const responseId = body.includes("resp_incomplete") ? "resp_incomplete" : "resp_failed";
  const provider = rawProvider({
    id: "raw",
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () => new Response(body, { headers: { "content-type": contentType } }),
  });
  const source = realUsageSource(defineProviderRouteSource([provider]).source);

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: jsonRequest({ input: "ping", model: REQUESTED_MODEL, stream: contentType === "text/event-stream" }),
    source,
  });
  await response.text();

  expect(previous(source, responseId).session.source).toBe("generated");
});

test("does not commit a completed raw response event when the client cancels before EOF", async () => {
  const encoder = new TextEncoder();
  const provider = rawProvider({
    id: "raw",
    modelId: REQUESTED_MODEL,
    protocol: ProviderProtocol.OpenAIResponse,
    invoke: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_cancelled","status":"completed"}}\n\n',
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const source = realUsageSource(defineProviderRouteSource([provider]).source);
  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: {},
    rawRequest: jsonRequest({ input: "ping", model: REQUESTED_MODEL, stream: true }),
    source,
  });
  const reader = response.body?.getReader();

  await reader?.read();
  await reader?.cancel("client stopped");

  expect(previous(source, "resp_cancelled").session.source).toBe("generated");
});

function realUsageSource(source: ProviderRouteSource): ProviderRouteSource {
  return { ...source, usageCapture: createUsageCapture({ priceCatalogTask: async () => undefined }) };
}

function previous(source: ProviderRouteSource, responseId: string) {
  return source.logicalSessionStore.begin({
    headers: new Headers(),
    hints: { candidates: [], previousResponseId: responseId, transcript: "different request" },
  });
}
