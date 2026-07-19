import { geminiGenerateContentAdapter } from "@aio-proxy/core";
import { Hono } from "hono";
import type { ProviderRouteSource } from "../runtime";
import { handleProtocolRequest } from "./pipeline";
import { handleTokenCount } from "./token-count";

const routePrefix = "/v1beta/models/";
const generateSuffix = ":generateContent";
const streamSuffix = ":streamGenerateContent";
const countSuffix = ":countTokens";

export function createGeminiGenerateContentRoutes(source: ProviderRouteSource) {
  return new Hono().post("/v1beta/models/*", (context) => {
    const target = routeTarget(new URL(context.req.url).pathname);
    if (target === undefined) {
      return context.text("404 Not Found", 404);
    }
    if (target.count) {
      return handleTokenCount({
        adapter: geminiGenerateContentAdapter,
        context: target,
        format: (inputTokens) => ({ totalTokens: inputTokens }),
        rawRequest: context.req.raw,
        source,
      });
    }
    return handleProtocolRequest({
      adapter: geminiGenerateContentAdapter,
      context: target,
      rawRequest: context.req.raw,
      source,
    });
  });
}

function routeTarget(
  pathname: string,
): { readonly count: boolean; readonly model: string; readonly stream: boolean } | undefined {
  if (!pathname.startsWith(routePrefix)) {
    return undefined;
  }

  const value = pathname.slice(routePrefix.length);
  if (value.endsWith(streamSuffix)) {
    const model = decodeURIComponent(value.slice(0, -streamSuffix.length));
    return model === "" ? undefined : { count: false, model, stream: true };
  }

  if (value.endsWith(generateSuffix)) {
    const model = decodeURIComponent(value.slice(0, -generateSuffix.length));
    return model === "" ? undefined : { count: false, model, stream: false };
  }

  if (value.endsWith(countSuffix)) {
    const model = decodeURIComponent(value.slice(0, -countSuffix.length));
    return model === "" ? undefined : { count: true, model, stream: false };
  }

  return undefined;
}
