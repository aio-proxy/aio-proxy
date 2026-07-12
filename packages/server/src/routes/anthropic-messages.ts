import { anthropicMessagesAdapter } from "@aio-proxy/core";
import { Hono } from "hono";
import type { ProviderRouteSource } from "../runtime";
import { handleProtocolRequest } from "./pipeline";

export function createAnthropicMessagesRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post("/v1/messages", (context) =>
      handleProtocolRequest({
        adapter: anthropicMessagesAdapter,
        context: {},
        rawRequest: context.req.raw,
        source,
      }),
    )
    .post("/v1/messages/count_tokens", async (context) => {
      try {
        const request = await anthropicMessagesAdapter.parse(context.req.raw, {});
        return Response.json({ input_tokens: tokenEstimate(request) });
      } catch (error) {
        const mapped = anthropicMessagesAdapter.errors.requestError(error);
        if (mapped !== undefined) return mapped;
        throw error;
      }
    });
}

function tokenEstimate(request: Awaited<ReturnType<typeof anthropicMessagesAdapter.parse>>): number {
  return Math.max(1, Math.ceil(JSON.stringify(request).length / 64));
}
