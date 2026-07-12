import { ZodError } from "zod";
import {
  AiSdkProviderError,
  AnthropicMessagesTransformError,
  GeminiGenerateContentTransformError,
  GeminiInlineDataTooLargeError,
  OpenAICompletionsTransformError,
  OpenAIResponsesTransformError,
  OpenAIResponsesUnsupportedFeatureError,
  ProviderNotInstalledError,
} from "../error";
import type { ProtocolErrorMapper } from "./adapter";

export const openAICompletionsErrors: ProtocolErrorMapper = {
  requestError: (error) =>
    error instanceof SyntaxError || error instanceof ZodError || error instanceof OpenAICompletionsTransformError
      ? openAIInvalid(400, "invalid_request", "Invalid OpenAI Completions request")
      : undefined,
  modelNotFound: (message) => openAIInvalid(404, "model_not_found", message),
  tooLarge: () => openAIInvalid(413, "request_too_large", "Request body too large"),
  unsupported: () =>
    openAIInvalid(501, "not_implemented", "Provider does not support OpenAI Completions transform dispatch"),
  provider: openAIProviderError,
};

export const openAIResponsesErrors: ProtocolErrorMapper = {
  requestError(error) {
    if (error instanceof OpenAIResponsesUnsupportedFeatureError) {
      return openAIUnsupported(error.feature);
    }
    return error instanceof SyntaxError || error instanceof ZodError || error instanceof OpenAIResponsesTransformError
      ? openAIInvalid(400, "invalid_request", "Invalid OpenAI Responses request")
      : undefined;
  },
  modelNotFound: (message) => openAIInvalid(404, "model_not_found", message),
  tooLarge: () => openAIInvalid(413, "request_too_large", "Request body too large"),
  unsupported: openAIUnsupported,
  provider: openAIProviderError,
};

export const anthropicMessagesErrors: ProtocolErrorMapper = {
  requestError: (error) =>
    error instanceof SyntaxError || error instanceof ZodError || error instanceof AnthropicMessagesTransformError
      ? anthropicError(400, "invalid_request_error", "Invalid Anthropic Messages request")
      : undefined,
  modelNotFound: (message) => anthropicError(404, "not_found_error", message),
  tooLarge: () => anthropicError(413, "invalid_request_error", "Request body too large"),
  unsupported: () =>
    anthropicError(501, "invalid_request_error", "Provider does not support Anthropic Messages transform dispatch"),
  provider: (error) =>
    genericProviderError(error, (status, message) => anthropicError(status, "invalid_request_error", message)),
};

export const geminiGenerateContentErrors: ProtocolErrorMapper = {
  requestError(error) {
    if (error instanceof GeminiInlineDataTooLargeError) {
      return geminiError(413, "RESOURCE_EXHAUSTED", error.message);
    }
    return error instanceof SyntaxError ||
      error instanceof ZodError ||
      error instanceof GeminiGenerateContentTransformError
      ? geminiError(400, "INVALID_ARGUMENT", "Invalid Gemini request")
      : undefined;
  },
  modelNotFound: (message) => geminiError(404, "NOT_FOUND", message),
  tooLarge: () => geminiError(413, "RESOURCE_EXHAUSTED", "Request body too large"),
  unsupported: () =>
    geminiError(501, "UNIMPLEMENTED", "Provider does not support Gemini generateContent transform dispatch"),
  provider: (error) => genericProviderError(error, (status, message) => geminiError(status, "UNAVAILABLE", message)),
};

function openAIProviderError(error: unknown): Response | undefined {
  const cause = error instanceof AiSdkProviderError ? error.cause : error;
  const missing = providerNotInstalled(error);
  if (missing !== undefined) {
    return openAIInvalid(503, "provider_not_installed", missing.message);
  }
  const message = providerMessage(cause);
  if (message === undefined) {
    return undefined;
  }
  if (isAbortOrTimeout(cause)) {
    return openAIInvalid(499, "aborted", message);
  }
  const status = statusCode(cause);
  return openAIInvalid(status ?? 500, status === undefined ? "internal_error" : "upstream_error", message);
}

function genericProviderError(
  error: unknown,
  response: (status: 500 | 503, message: string) => Response,
): Response | undefined {
  const missing = providerNotInstalled(error);
  if (missing !== undefined) {
    return response(503, missing.message);
  }
  const message = providerMessage(error);
  return message === undefined ? undefined : response(500, message);
}

function providerNotInstalled(error: unknown): ProviderNotInstalledError | undefined {
  if (error instanceof ProviderNotInstalledError) {
    return error;
  }
  return error instanceof AiSdkProviderError && error.cause instanceof ProviderNotInstalledError
    ? error.cause
    : undefined;
}

function providerMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error === null) return "Upstream provider error";
  if (typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return undefined;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("statusCode" in error && typeof error.statusCode === "number") return error.statusCode;
  if ("status" in error && typeof error.status === "number") return error.status;
  if (
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    typeof error.response.status === "number"
  )
    return error.response.status;
  return undefined;
}

function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function openAIUnsupported(feature: string): Response {
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

function openAIInvalid(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, type: "invalid_request_error" } }, { status });
}

function anthropicError(status: number, type: "invalid_request_error" | "not_found_error", message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

function geminiError(
  code: 400 | 404 | 413 | 500 | 501 | 503,
  status: "INVALID_ARGUMENT" | "NOT_FOUND" | "RESOURCE_EXHAUSTED" | "UNAVAILABLE" | "UNIMPLEMENTED",
  message: string,
): Response {
  return Response.json({ error: { code, message, status } }, { status: code });
}
