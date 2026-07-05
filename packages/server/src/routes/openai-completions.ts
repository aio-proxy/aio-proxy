import {
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
import { resolveCandidates, shouldTryNextResponse, toAiSdkProvider } from "../route-dispatch";
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

    const candidates = resolveCandidates(source, request.model);
    if (candidates instanceof RouterModelNotFoundError) {
      return openAIError(404, "model_not_found", candidates.message);
    }

    const transformed = openAICompletionsToModelMessages(request);
    let last = openAIError(501, "not_implemented", "Provider does not support OpenAI Completions transform dispatch");
    for (const [index, route] of candidates.entries()) {
      const hasNext = index < candidates.length - 1;
      const provider = route.provider;
      if (provider.kind === ProviderKind.Api && provider.protocol === ProviderProtocol.OpenAICompatible) {
        const response = await provider.passthrough(context.req.raw.clone());
        if (hasNext && shouldTryNextResponse(response)) {
          last = response;
          continue;
        }
        return response;
      }

      const aiSdkProvider = toAiSdkProvider(provider);
      if (aiSdkProvider === undefined) {
        last = openAIError(501, "not_implemented", "Provider does not support OpenAI Completions transform dispatch");
        continue;
      }

      try {
        await ensureAiSdkProviderAvailable(aiSdkProvider);
        const stream = aiSdkProvider.invoke({
          messages: transformed.messages,
          modelId: route.modelId,
          settings: transformed.settings,
          signal: context.req.raw.signal,
        });
        if (request.stream !== true) {
          return Response.json(await writeOpenAICompletionsResponse(stream));
        }

        return new Response(writeOpenAICompletionsSSE(stream), {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream; charset=utf-8",
          },
        });
      } catch (error) {
        // no-excuse-ok: catch - HTTP boundary converts provider failures.
        const ingressError = toIngressError(error, "openai");
        last = Response.json(ingressError.body, {
          status: ingressError.status,
        });
        if (hasNext && shouldTryNextResponse(last)) {
          continue;
        }
        return last;
      }
    }

    return last;
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

function openAIError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, type: "invalid_request_error" } }, { status });
}
