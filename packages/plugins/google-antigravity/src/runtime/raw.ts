import type { RawResolver } from "@aio-proxy/plugin-sdk";

import type { CcaTransport } from "./transport";

import { AntigravityThinkingError, geminiThinkingConfig } from "../protocol/thinking";
import { AntigravityToolSchemaValidationError } from "../protocol/tool-schema";
import { AntigravityUpstreamError } from "./errors";
import { unwrapCcaSse } from "./stream";

export function createGeminiRawResolver(transport: CcaTransport): RawResolver {
  return ({ protocol, modelId }) => {
    if (protocol !== "gemini") return undefined;
    return {
      async invoke(request, context) {
        if (context === undefined) return createGeminiErrorResponse(500);
        const stream = operation(request);
        if (stream === undefined) return createGeminiErrorResponse(400);
        throwIfAborted(request.signal);
        const parsedBody = await readBody(request);
        if (parsedBody === undefined) return createGeminiErrorResponse(400);
        let body: Record<string, unknown>;
        try {
          body = normalizeGeminiThinking(parsedBody, modelId);
        } catch {
          return createGeminiErrorResponse(400);
        }

        let response: Response;
        try {
          response = await transport.execute({
            body,
            context,
            modelId,
            requestType: "agent",
            stream,
            signal: request.signal,
          });
        } catch (error) {
          if (request.signal.aborted) {
            const reason: unknown = request.signal.reason;
            throw reason ?? new DOMException("The operation was aborted", "AbortError");
          }
          if (error instanceof AntigravityToolSchemaValidationError) return createGeminiErrorResponse(400);
          if (isAbort(error)) throw error;
          return createGeminiErrorResponse(error instanceof AntigravityUpstreamError ? (error.status ?? 503) : 503);
        }

        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel().catch(() => undefined);
          return createGeminiErrorResponse(status);
        }
        if (stream) {
          if (response.body === null) return createGeminiErrorResponse(500);
          return new Response(unwrapCcaSse(response.body), {
            headers: { "Content-Type": "text/event-stream; charset=utf-8" },
            status: response.status,
          });
        }

        try {
          return Response.json(unwrapCcaJson(await response.json()));
        } catch {
          throwIfAborted(request.signal);
          return createGeminiErrorResponse(500);
        }
      },
    };
  };
}

function normalizeGeminiThinking(body: Record<string, unknown>, modelId: string): Record<string, unknown> {
  const generationConfig = record(Reflect.get(body, "generationConfig"));
  if (generationConfig === undefined || !Object.hasOwn(generationConfig, "thinkingConfig")) return body;
  const thinkingConfig = record(Reflect.get(generationConfig, "thinkingConfig"));
  if (thinkingConfig === undefined) {
    throw new AntigravityThinkingError("Gemini thinkingConfig must be an object");
  }
  return {
    ...body,
    generationConfig: { ...generationConfig, thinkingConfig: geminiThinkingConfig(modelId, thinkingConfig) },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function unwrapCcaJson(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const response = Reflect.get(payload, "response");
  return response ?? payload;
}

function operation(request: Request): boolean | undefined {
  if (request.method !== "POST") return undefined;
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith(":generateContent")) return false;
  if (pathname.endsWith(":streamGenerateContent")) return true;
  return undefined;
}

async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    throwIfAborted(request.signal);
    return undefined;
  }
}

export function createGeminiErrorResponse(status: number): Response {
  const code = validStatus(status) ? status : 500;
  return Response.json(
    {
      error: {
        code,
        message: "Google Antigravity request failed",
        status: geminiStatus(code),
      },
    },
    { status: code },
  );
}

function geminiStatus(status: number): string {
  switch (status) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 408:
    case 504:
      return "DEADLINE_EXCEEDED";
    case 409:
      return "ABORTED";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 499:
      return "CANCELLED";
    case 501:
      return "UNIMPLEMENTED";
    case 503:
      return "UNAVAILABLE";
    default:
      return status >= 500 ? "INTERNAL" : "UNKNOWN";
  }
}

function validStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  throw reason ?? new DOMException("The operation was aborted", "AbortError");
}
