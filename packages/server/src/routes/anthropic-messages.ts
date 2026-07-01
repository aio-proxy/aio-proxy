import {
  type AnthropicModelMessage,
  anthropicMessagesToModelMessages,
  type ModelMessage,
  parseAnthropicMessages,
  Router,
  RouterModelNotFoundError,
  type TextStreamPart,
  type ToolSet,
  writeAnthropicMessagesSSE,
} from "@aio-proxy/core";
import { Hono } from "hono";
import { ZodError } from "zod";
import type { RuntimeProviderInstance } from "./openai-chat";

declare module "@aio-proxy/core" {
  export function writeAnthropicMessagesSSE(
    stream: ReadableStream<TextStreamPart<ToolSet>>,
  ): ReadableStream<Uint8Array>;
}

const maxBodyBytes = 8 * 1_024 * 1_024;

export function createAnthropicMessagesRoutes(
  providers: readonly RuntimeProviderInstance[],
) {
  const router = new Router(providers);

  return new Hono()
    .post("/v1/messages", async (context) => {
      const contentLength = context.req.header("content-length");
      if (
        contentLength !== undefined &&
        Number.parseInt(contentLength, 10) > maxBodyBytes
      ) {
        return anthropicError(
          413,
          "invalid_request_error",
          "Request body too large",
        );
      }

      const request = await parseRequest(context.req.raw);
      if (request instanceof Response) {
        return request;
      }

      const route = resolveRoute(router, request.model);
      if (route instanceof Response) {
        return route;
      }

      const provider = route.provider;
      if (
        provider.kind === "api" &&
        provider.protocol === "anthropic-messages" &&
        provider.vendor === "anthropic-native"
      ) {
        return provider.passthrough(context.req.raw);
      }

      if (provider.kind !== "ai-sdk") {
        return anthropicError(
          501,
          "invalid_request_error",
          "Provider does not support Anthropic Messages transform dispatch",
        );
      }

      const transformed = anthropicMessagesToModelMessages(request);
      const stream = provider.invoke({
        messages: aiSdkMessages(transformed.messages),
        modelId: route.modelId,
        settings: transformed.settings,
        signal: context.req.raw.signal,
      });

      if (request.stream === true) {
        return new Response(writeAnthropicMessagesSSE(stream), {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream; charset=utf-8",
          },
        });
      }

      return Response.json(await anthropicMessage(stream));
    })
    .post("/v1/messages/count_tokens", async (context) => {
      const request = await parseRequest(context.req.raw);
      if (request instanceof Response) {
        return request;
      }

      return Response.json({ input_tokens: tokenEstimate(request) });
    });
}

async function parseRequest(
  raw: Request,
): Promise<ReturnType<typeof parseAnthropicMessages> | Response> {
  try {
    return parseAnthropicMessages(await raw.clone().json());
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return anthropicError(
        400,
        "invalid_request_error",
        "Invalid Anthropic Messages request",
      );
    }

    throw error;
  }
}

function resolveRoute(router: Router<RuntimeProviderInstance>, model: string) {
  try {
    return router.resolve(model);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return anthropicError(404, "not_found_error", error.message);
    }

    throw error;
  }
}

async function anthropicMessage(
  stream: ReturnType<
    Extract<RuntimeProviderInstance, { kind: "ai-sdk" }>["invoke"]
  >,
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

function aiSdkMessages(
  messages: readonly AnthropicModelMessage[],
): readonly ModelMessage[] {
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

function tokenEstimate(
  request: ReturnType<typeof parseAnthropicMessages>,
): number {
  return Math.max(1, Math.ceil(JSON.stringify(request).length / 64));
}

function anthropicError(
  status: number,
  type: "invalid_request_error" | "not_found_error",
  message: string,
): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Anthropic message part: ${String(value)}`);
}
