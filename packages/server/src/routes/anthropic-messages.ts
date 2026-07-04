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

      const route = resolveRoute(source, request.model);
      if (route instanceof Response) {
        return route;
      }

      const provider = route.provider;
      if (provider.kind === ProviderKind.Api && provider.protocol === ProviderProtocol.Anthropic) {
        return provider.passthrough(context.req.raw);
      }

      if (provider.kind !== ProviderKind.AiSdk) {
        return anthropicError(
          501,
          "invalid_request_error",
          "Provider does not support Anthropic Messages transform dispatch",
        );
      }

      const transformed = anthropicMessagesToModelMessages(request);

      if (request.stream === true) {
        let stream: ReturnType<typeof provider.invoke>;
        try {
          await ensureAiSdkProviderAvailable(provider);
          stream = provider.invoke({
            messages: aiSdkMessages(transformed.messages),
            modelId: route.modelId,
            settings: transformed.settings,
            signal: context.req.raw.signal,
          });
        } catch (error) {
          // no-excuse-ok: catch - HTTP boundary converts provider failures.
          return anthropicProviderError(error);
        }

        return new Response(writeAnthropicMessagesSSE(stream), {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream; charset=utf-8",
          },
        });
      }

      try {
        await ensureAiSdkProviderAvailable(provider);
        const stream = provider.invoke({
          messages: aiSdkMessages(transformed.messages),
          modelId: route.modelId,
          settings: transformed.settings,
          signal: context.req.raw.signal,
        });
        return Response.json(await anthropicMessage(stream));
      } catch (error) {
        // no-excuse-ok: catch - HTTP boundary converts provider failures.
        return anthropicProviderError(error);
      }
    })
    .post("/v1/messages/count_tokens", async (context) => {
      const request = await parseRequest(context.req.raw);
      if (request instanceof Response) {
        return request;
      }

      return Response.json({ input_tokens: tokenEstimate(request) });
    });
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

function resolveRoute(source: ProviderRouteSource, model: string) {
  try {
    return source.currentProviderSnapshot().router.resolve(model);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return anthropicError(404, "not_found_error", error.message);
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

  if (error instanceof Error) {
    return anthropicError(500, "invalid_request_error", error.message);
  }

  throw error;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Anthropic message part: ${String(value)}`);
}
