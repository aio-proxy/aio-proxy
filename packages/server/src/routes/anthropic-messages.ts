import { anthropicMessagesAdapter } from "@aio-proxy/core";
import { Hono } from "hono";

import type { ProviderRouteSource } from "../runtime";

import { handleProtocolRequest } from "./pipeline";
import { handleTokenCount } from "./token-count";

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
    .post("/v1/messages/count_tokens", (context) =>
      handleTokenCount({
        adapter: anthropicMessagesAdapter,
        context: {},
        format: (inputTokens) => ({ input_tokens: inputTokens }),
        rawRequest: context.req.raw,
        source,
      }),
    );
}
