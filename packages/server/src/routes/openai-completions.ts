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
import {
  preflightStream,
  resolveCandidates,
  rewriteJsonRequestModel,
  shouldTryNextResponse,
  toAiSdkProvider,
} from "../route-dispatch";
import { isInboundAbort, terminalCompletion } from "../route-observation";
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

    const candidates = resolveCandidates(source, request.model, request.reasoning_effort);
    if (candidates instanceof RouterModelNotFoundError) {
      return openAIError(404, "model_not_found", candidates.message);
    }

    const transformed = openAICompletionsToModelMessages(request);
    const requestSession = source.requestRecorder.begin({
      inboundProtocol: ProviderProtocol.OpenAICompatible,
      requestedModelId: request.model,
    });
    let last = openAIError(501, "not_implemented", "Provider does not support OpenAI Completions transform dispatch");
    for (const [index, route] of candidates.entries()) {
      const attemptStartedAt = performance.now();
      const hasNext = index < candidates.length - 1;
      const provider = route.provider;
      try {
        if (provider.kind === ProviderKind.Api && provider.protocol === ProviderProtocol.OpenAICompatible) {
          const upstreamRequest =
            request.model === route.modelId
              ? context.req.raw.clone()
              : await rewriteJsonRequestModel(context.req.raw, route.modelId);
          const response = await provider.passthrough(upstreamRequest);
          if (hasNext && shouldTryNextResponse(response)) {
            requestSession.attempt({
              providerId: provider.id,
              modelId: route.modelId,
              providerKind: provider.kind,
              protocol: provider.protocol,
              outcome: "failure",
              statusCode: response.status,
              durationMs: durationMs(attemptStartedAt),
            });
            last = response;
            continue;
          }
          if (response.status < 200 || response.status >= 400) {
            requestSession.finish({
              outcome: "failure",
              finalProviderId: provider.id,
              finalModelId: route.modelId,
              finalStatusCode: response.status,
              attempt: {
                providerId: provider.id,
                modelId: route.modelId,
                providerKind: provider.kind,
                protocol: provider.protocol,
                outcome: "failure",
                statusCode: response.status,
                durationMs: durationMs(attemptStartedAt),
              },
            });
            return response;
          }
          const captured = source.usageCapture.passthrough({
            response,
            protocol: provider.protocol,
            providerId: provider.id,
            modelId: route.modelId,
          });
          requestSession.finishFrom(
            {
              providerId: provider.id,
              modelId: route.modelId,
              providerKind: provider.kind,
              protocol: provider.protocol,
              durationMs: durationMs(attemptStartedAt),
            },
            terminalCompletion(captured.completion, context.req.raw.signal),
          );
          return captured.value;
        }

        const aiSdkProvider = toAiSdkProvider(provider);
        if (aiSdkProvider === undefined) {
          last = openAIError(501, "not_implemented", "Provider does not support OpenAI Completions transform dispatch");
          const attempt = {
            providerId: provider.id,
            modelId: route.modelId,
            providerKind: provider.kind,
            ...(provider.kind === ProviderKind.Api ? { protocol: provider.protocol } : {}),
            outcome: "failure" as const,
            statusCode: last.status,
            durationMs: durationMs(attemptStartedAt),
          };
          if (hasNext) {
            requestSession.attempt(attempt);
            continue;
          }
          requestSession.finish({
            outcome: "failure",
            finalProviderId: provider.id,
            finalModelId: route.modelId,
            finalStatusCode: last.status,
            attempt,
          });
          continue;
        }

        await ensureAiSdkProviderAvailable(aiSdkProvider);
        const captured = source.usageCapture.stream({
          providerId: provider.id,
          modelId: route.modelId,
          stream: aiSdkProvider.invoke({
            messages: transformed.messages,
            modelId: route.modelId,
            settings: transformed.settings,
            signal: context.req.raw.signal,
          }),
        });
        if (request.stream !== true) {
          const value = await writeOpenAICompletionsResponse(captured.value);
          const completion = await terminalCompletion(captured.completion, context.req.raw.signal);
          requestSession.finish({
            outcome: completion.outcome,
            finalProviderId: provider.id,
            finalModelId: route.modelId,
            attempt: {
              providerId: provider.id,
              modelId: route.modelId,
              providerKind: provider.kind,
              outcome: completion.outcome,
              durationMs: durationMs(attemptStartedAt),
            },
            ...(completion.outcome === "success" && completion.usage !== undefined ? { usage: completion.usage } : {}),
          });
          return Response.json(value);
        }

        const stream = await preflightStream(captured.value);
        requestSession.finishFrom(
          {
            providerId: provider.id,
            modelId: route.modelId,
            providerKind: provider.kind,
            durationMs: durationMs(attemptStartedAt),
          },
          terminalCompletion(captured.completion, context.req.raw.signal),
        );
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
          requestSession.attempt({
            providerId: provider.id,
            modelId: route.modelId,
            providerKind: provider.kind,
            ...(provider.kind === ProviderKind.Api ? { protocol: provider.protocol } : {}),
            outcome: "failure",
            statusCode: last.status,
            durationMs: durationMs(attemptStartedAt),
          });
          continue;
        }
        const outcome = isInboundAbort(error, context.req.raw.signal) ? "cancelled" : "failure";
        requestSession.finish({
          outcome,
          finalProviderId: provider.id,
          finalModelId: route.modelId,
          finalStatusCode: last.status,
          attempt: {
            providerId: provider.id,
            modelId: route.modelId,
            providerKind: provider.kind,
            ...(provider.kind === ProviderKind.Api ? { protocol: provider.protocol } : {}),
            outcome,
            statusCode: last.status,
            durationMs: durationMs(attemptStartedAt),
          },
        });
        return last;
      }
    }

    return last;
  });
}

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
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
