import {
  type AnthropicModelMessage,
  anthropicMessagesToModelMessages,
  type ModelMessage,
  parseAnthropicMessages,
  RouterModelNotFoundError,
  writeAnthropicMessagesSSE,
} from "@aio-proxy/core";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { Hono } from "hono";
import { ZodError } from "zod";
import { ensureAiSdkProviderAvailable, providerNotInstalled } from "../provider-availability";
import { resolveCandidates, shouldTryNextResponse, toAiSdkProvider } from "../route-dispatch";
import { isInboundAbort, providerErrorMessage, terminalCompletion } from "../route-observation";
import type { ProviderRouteSource, RuntimeProviderInstance } from "../runtime";

const maxBodyBytes = 8 * 1_024 * 1_024;

export function createAnthropicMessagesRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post("/v1/messages", async (context) => {
      const contentLength = context.req.header("content-length");
      if (contentLength !== undefined && Number.parseInt(contentLength, 10) > maxBodyBytes) {
        return anthropicError(413, "invalid_request_error", "Request body too large");
      }

      const request = await parseRequest(context.req.raw);
      if (request instanceof Response) {
        return request;
      }

      const candidates = resolveCandidates(source, request.model);
      if (candidates instanceof RouterModelNotFoundError) {
        return anthropicError(404, "not_found_error", candidates.message);
      }

      const transformed = anthropicMessagesToModelMessages(request);
      const requestSession = source.requestRecorder.begin({
        inboundProtocol: ProviderProtocol.Anthropic,
        requestedModelId: request.model,
      });
      let last = anthropicError(
        501,
        "invalid_request_error",
        "Provider does not support Anthropic Messages transform dispatch",
      );
      for (const [index, route] of candidates.entries()) {
        const attemptStartedAt = performance.now();
        const hasNext = index < candidates.length - 1;
        const provider = route.provider;
        try {
          if (provider.kind === ProviderKind.Api && provider.protocol === ProviderProtocol.Anthropic) {
            const response = await provider.passthrough(context.req.raw.clone());
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
            last = anthropicError(
              501,
              "invalid_request_error",
              "Provider does not support Anthropic Messages transform dispatch",
            );
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
              messages: aiSdkMessages(transformed.messages),
              modelId: route.modelId,
              settings: transformed.settings,
              signal: context.req.raw.signal,
            }),
          });
          if (request.stream !== true) {
            const value = await anthropicMessage(captured.value);
            requestSession.finishFrom(
              {
                providerId: provider.id,
                modelId: route.modelId,
                providerKind: provider.kind,
                durationMs: durationMs(attemptStartedAt),
              },
              terminalCompletion(captured.completion, context.req.raw.signal),
            );
            return Response.json(value);
          }

          requestSession.finishFrom(
            {
              providerId: provider.id,
              modelId: route.modelId,
              providerKind: provider.kind,
              durationMs: durationMs(attemptStartedAt),
            },
            terminalCompletion(captured.completion, context.req.raw.signal),
          );
          return new Response(writeAnthropicMessagesSSE(captured.value), {
            headers: {
              "cache-control": "no-cache",
              "content-type": "text/event-stream; charset=utf-8",
            },
          });
        } catch (error) {
          // no-excuse-ok: catch - HTTP boundary converts provider failures.
          last = anthropicProviderError(error);
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
    .post("/v1/messages/count_tokens", async (context) => {
      const request = await parseRequest(context.req.raw);
      if (request instanceof Response) {
        return request;
      }

      return Response.json({ input_tokens: tokenEstimate(request) });
    });
}

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function parseRequest(raw: Request): Promise<ReturnType<typeof parseAnthropicMessages> | Response> {
  try {
    return parseAnthropicMessages(await raw.clone().json());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return anthropicError(400, "invalid_request_error", "Invalid Anthropic Messages request");
    }

    throw error;
  }
}

async function anthropicMessage(
  stream: ReturnType<Extract<RuntimeProviderInstance, { kind: ProviderKind.AiSdk }>["invoke"]>,
) {
  const text: string[] = [];
  let stopReason: "end_turn" | "max_tokens" = "end_turn";

  for await (const part of stream) {
    switch (part.type) {
      case "text-delta":
        text.push(part.text);
        break;
      case "finish":
        stopReason = part.finishReason === "length" ? "max_tokens" : "end_turn";
        break;
      default:
        break;
    }
  }

  return {
    id: "msg_aio_proxy",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: text.join("") }],
    model: "aio-proxy",
    stop_reason: stopReason,
    stop_sequence: null,
  };
}

function aiSdkMessages(messages: readonly AnthropicModelMessage[]): readonly ModelMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return { role: "user", content: contentText(message.content) };
      case "assistant":
        return { role: "assistant", content: contentText(message.content) };
      case "tool":
        return { role: "tool", content: [] };
      default:
        return assertNever(message);
    }
  });
}

function contentText(content: AnthropicModelMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      switch (part.type) {
        case "text":
        case "reasoning":
          return part.text;
        case "tool-call":
          return "";
        case "tool-result":
          return part.output.type === "text"
            ? part.output.value
            : part.output.value.map((value) => value.text).join("");
        default:
          return assertNever(part);
      }
    })
    .join("");
}

function tokenEstimate(request: ReturnType<typeof parseAnthropicMessages>): number {
  return Math.max(1, Math.ceil(JSON.stringify(request).length / 64));
}

function anthropicError(status: number, type: "invalid_request_error" | "not_found_error", message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

function anthropicProviderError(error: unknown): Response {
  const missing = providerNotInstalled(error);
  if (missing !== undefined) {
    return anthropicError(503, "invalid_request_error", missing.message);
  }

  return anthropicError(500, "invalid_request_error", providerErrorMessage(error));
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Anthropic message part: ${String(value)}`);
}
