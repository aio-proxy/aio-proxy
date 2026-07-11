import {
  type JSONValue,
  jsonSchema,
  type OpenAIResponsesTransformTool,
  OpenAIResponsesUnsupportedFeatureError,
  openAIResponsesToModelMessages,
  parseOpenAIResponses,
  RouterModelNotFoundError,
  type ToolSet,
  toIngressError,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from "@aio-proxy/core";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { Hono } from "hono";
import { ZodError, z } from "zod";
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
const jsonValueSchema = z.json();

export function createOpenAIResponsesRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post("/v1/responses", async (context) => {
      const contentLength = context.req.header("content-length");
      if (contentLength !== undefined && Number.parseInt(contentLength, 10) > maxBodyBytes) {
        return openAIError(413, "request_too_large", "Request body too large");
      }

      const request = await parseRequest(context.req.raw);
      if (request instanceof Response) {
        return request;
      }

      const candidates = resolveCandidates(source, request.model, request.reasoning?.effort);
      if (candidates instanceof RouterModelNotFoundError) {
        return openAIError(404, "model_not_found", candidates.message);
      }

      const transformed = openAIResponsesToModelMessages(request);
      const tools = aiSdkTools(transformed.tools);
      if (tools instanceof Response) {
        return tools;
      }

      const requestSession = source.requestRecorder.begin({
        inboundProtocol: ProviderProtocol.OpenAIResponse,
        requestedModelId: request.model,
      });
      let last = unsupportedFeature("openai_responses_transform_dispatch");
      for (const [index, route] of candidates.entries()) {
        const attemptStartedAt = performance.now();
        const hasNext = index < candidates.length - 1;
        const provider = route.provider;
        try {
          if (provider.kind === ProviderKind.Api && provider.protocol === ProviderProtocol.OpenAIResponse) {
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
            last = unsupportedFeature("openai_responses_transform_dispatch");
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
              ...(tools === undefined ? {} : { tools }),
            }),
          });
          if (request.stream !== true) {
            const value = await writeOpenAIResponsesResponse(captured.value);
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
              ...(completion.outcome === "success" && completion.usage !== undefined
                ? { usage: completion.usage }
                : {}),
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
          return new Response(writeOpenAIResponsesSSE(stream), {
            headers: {
              "cache-control": "no-cache",
              "content-type": "text/event-stream; charset=utf-8",
            },
          });
        } catch (error) {
          // no-excuse-ok: catch - HTTP boundary converts provider failures.
          const ingressError = toIngressError(error, "openai");
          last = Response.json(ingressError.body, { status: ingressError.status });
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
    })
    .get("/v1/responses/:id", () => unsupportedFeature("response_retrieval"));
}

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function parseRequest(raw: Request): Promise<ReturnType<typeof parseOpenAIResponses> | Response> {
  try {
    return parseOpenAIResponses(await raw.clone().json());
  } catch (error) {
    if (error instanceof OpenAIResponsesUnsupportedFeatureError) {
      return unsupportedFeature(error.feature);
    }

    if (error instanceof SyntaxError || error instanceof ZodError) {
      return openAIError(400, "invalid_request", "Invalid OpenAI Responses request");
    }

    throw error;
  }
}

function aiSdkTools(tools: readonly OpenAIResponsesTransformTool[] | undefined): ToolSet | Response | undefined {
  if (tools === undefined) {
    return undefined;
  }

  const result: ToolSet = {};
  for (const tool of tools) {
    if (tool.type === "custom") {
      return unsupportedFeature("custom_tool");
    }

    result[tool.name] = {
      type: "function",
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: jsonSchema(jsonSchemaObject(tool.inputSchema)),
      outputSchema: jsonSchema({}),
    };
  }

  return result;
}

function jsonSchemaObject(value: unknown): Parameters<typeof jsonSchema>[0] {
  const json = jsonValue(value);
  if (json === undefined || json === null || Array.isArray(json)) {
    return {};
  }

  if (typeof json === "object") {
    return json;
  }

  return {};
}

function jsonValue(value: unknown): JSONValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function unsupportedFeature(feature: string): Response {
  return Response.json(
    {
      error: {
        code: "unsupported_feature",
        message: `OpenAI Responses feature is not supported: ${feature}`,
        type: "unsupported_feature",
      },
    },
    { status: 501 },
  );
}

function openAIError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, type: "invalid_request_error" } }, { status });
}
