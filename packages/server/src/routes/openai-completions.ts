import {
  bridgeApiProviderToAiSdk,
  openAICompletionsToModelMessages,
  parseOpenAICompletions,
  RouterModelNotFoundError,
  toIngressError,
  writeOpenAICompletionsResponse,
  writeOpenAICompletionsSSE,
} from "@aio-proxy/core";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { Hono } from "hono";
import { ZodError } from "zod";
import { ensureAiSdkProviderAvailable } from "../provider-availability";
import type { ProviderRouteSource } from "../runtime";

const maxBodyBytes = 8 * 1_024 * 1_024;

export function createOpenAICompletionsRoutes(source: ProviderRouteSource) {
  return new Hono().post("/v1/chat/completions", async (context) => {
    const contentLength = context.req.header("content-length");
    if (contentLength !== undefined && Number.parseInt(contentLength, 10) > maxBodyBytes) {
      return openAIError(413, "request_too_large", "Request body too large");
    }

    const request = await parseRequest(context.req.raw);
    if (request instanceof Response) {
      return request;
    }

    const route = resolveRoute(source, request.model);
    if (route instanceof Response) {
      return route;
    }

    const provider = route.provider;
    if (provider.kind === ProviderKind.Api && provider.protocol === ProviderProtocol.OpenAICompatible) {
      return provider.passthrough(context.req.raw);
    }

    const aiSdkProvider =
      provider.kind === ProviderKind.Api
        ? bridgeApiProviderToAiSdk({
            ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
            ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
            id: provider.id,
            kind: provider.kind,
            ...(provider.models === undefined ? {} : { models: [...provider.models] }),
            protocol: provider.protocol,
          })
        : provider;
    if (aiSdkProvider === undefined || aiSdkProvider.kind !== ProviderKind.AiSdk) {
      return openAIError(501, "not_implemented", "Provider does not support OpenAI Completions transform dispatch");
    }

    const transformed = openAICompletionsToModelMessages(request);

    if (request.stream !== true) {
      try {
        await ensureAiSdkProviderAvailable(aiSdkProvider);
        const stream = aiSdkProvider.invoke({
          messages: transformed.messages,
          modelId: route.modelId,
          settings: transformed.settings,
          signal: context.req.raw.signal,
        });
        return Response.json(await writeOpenAICompletionsResponse(stream));
      } catch (error) {
        // no-excuse-ok: catch - HTTP boundary converts provider failures.
        const ingressError = toIngressError(error, "openai");
        return Response.json(ingressError.body, {
          status: ingressError.status,
        });
      }
    }

    try {
      await ensureAiSdkProviderAvailable(aiSdkProvider);
      const stream = aiSdkProvider.invoke({
        messages: transformed.messages,
        modelId: route.modelId,
        settings: transformed.settings,
        signal: context.req.raw.signal,
      });

      return new Response(writeOpenAICompletionsSSE(stream), {
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/event-stream; charset=utf-8",
        },
      });
    } catch (error) {
      // no-excuse-ok: catch - HTTP boundary converts provider failures.
      const ingressError = toIngressError(error, "openai");
      return Response.json(ingressError.body, {
        status: ingressError.status,
      });
    }
  });
}

async function parseRequest(raw: Request): Promise<ReturnType<typeof parseOpenAICompletions> | Response> {
  try {
    return parseOpenAICompletions(await raw.clone().json());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return openAIError(400, "invalid_request", "Invalid OpenAI Completions request");
    }

    throw error;
  }
}

function resolveRoute(source: ProviderRouteSource, model: string) {
  try {
    return source.currentProviderSnapshot().router.resolve(model);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return openAIError(404, "model_not_found", error.message);
    }

    throw error;
  }
}

function openAIError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, type: "invalid_request_error" } }, { status });
}
