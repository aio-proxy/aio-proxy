import { openAIResponsesAdapter } from "@aio-proxy/core";
import { Hono } from "hono";

import type { ProviderRouteSource } from "../runtime";

import { handleProtocolRequest } from "./pipeline";

export function createOpenAIResponsesRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post("/v1/responses", (context) =>
      handleProtocolRequest({
        adapter: openAIResponsesAdapter,
        context: {},
        rawRequest: context.req.raw,
        source,
      }),
    )
    .get("/v1/responses/:id", () => openAIResponsesAdapter.errors.unsupported("response_retrieval"));
}
