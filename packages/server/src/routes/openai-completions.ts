import { openAICompletionsAdapter } from "@aio-proxy/core";
import { Hono } from "hono";
import type { ProviderRouteSource } from "../runtime";
import { handleProtocolRequest } from "./pipeline";

export function createOpenAICompletionsRoutes(source: ProviderRouteSource) {
  return new Hono().post("/v1/chat/completions", (context) =>
    handleProtocolRequest({
      adapter: openAICompletionsAdapter,
      context: {},
      rawRequest: context.req.raw,
      source,
    }),
  );
}
