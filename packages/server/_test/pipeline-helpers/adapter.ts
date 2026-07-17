import { defineProtocolAdapter as defineCoreProtocolAdapter, type ModelEventStream } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ModelPart, TestProtocolContext, TestProtocolRequest } from "./types";

export function createProtocolContext(): TestProtocolContext {
  return { modelInvocationCalls: 0, parseCalls: 0, rawRequestCalls: 0 };
}

export function defineProtocolAdapter(
  protocol: ProviderProtocol = ProviderProtocol.OpenAICompatible,
  options: {
    readonly modelInvocationError?: Error;
    readonly onModelEgress?: (value: unknown) => void;
    readonly parseError?: Error;
  } = {},
) {
  return defineCoreProtocolAdapter<TestProtocolRequest, TestProtocolContext>({
    protocol,
    async parse(raw, context) {
      context.parseCalls += 1;
      if (options.parseError !== undefined) throw options.parseError;
      const value: unknown = await raw.clone().json();
      if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        !("model" in value) ||
        typeof value.model !== "string"
      ) {
        throw new SyntaxError("invalid test request");
      }
      return {
        model: value.model,
        prompt: "prompt" in value && typeof value.prompt === "string" ? value.prompt : "ping",
        stream: "stream" in value && value.stream === true,
      };
    },
    model: (request) => request.model,
    wantsStream: (request) => request.stream,
    async rawRequest(raw, request, resolvedModel, context) {
      context.rawRequestCalls += 1;
      const headers = new Headers(raw.headers);
      headers.delete("content-length");
      return new Request(raw, {
        body: JSON.stringify({ ...request, model: resolvedModel }),
        headers,
      });
    },
    modelInvocation(request, context) {
      context.modelInvocationCalls += 1;
      if (options.modelInvocationError !== undefined) throw options.modelInvocationError;
      return { messages: [{ role: "user", content: request.prompt }] };
    },
    async modelJson(stream, ...args: unknown[]) {
      options.onModelEgress?.(args[0]);
      return { output: await streamText(stream) };
    },
    modelSse(stream, ...args: unknown[]) {
      options.onModelEgress?.(args[0]);
      const encoder = new TextEncoder();
      return stream.pipeThrough(
        new TransformStream<ModelPart, Uint8Array>({
          transform(part, controller) {
            if (part.type === "text-delta") {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: part.text })}\n\n`));
            }
          },
        }),
      );
    },
    errors: {
      requestError: (error) =>
        error instanceof SyntaxError ? errorResponse(400, "request_error", "Invalid test request") : undefined,
      modelNotFound: (message) => errorResponse(404, "model_not_found", message),
      tooLarge: () => errorResponse(413, "too_large", "Request body too large"),
      unsupported: (feature) => errorResponse(501, "unsupported", feature),
      provider: (error) => (error instanceof Error ? errorResponse(502, "provider_error", error.message) : undefined),
    },
  });
}

async function streamText(stream: ModelEventStream): Promise<string> {
  let text = "";
  for await (const part of stream) {
    if (part.type === "text-delta") text += part.text;
  }
  return text;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
