import { APICallError } from '@ai-sdk/provider';
import { RetryError } from 'ai';
import { prettifyError, ZodError } from 'zod';

import {
  AiSdkProviderError,
  AnthropicMessagesTransformError,
  GeminiGenerateContentTransformError,
  GeminiInlineDataTooLargeError,
  ImageInputUnsupportedError,
  OpenAICompletionsTransformError,
  OpenAIResponsesTransformError,
  OpenAIResponsesUnsupportedFeatureError,
  ProviderNotInstalledError,
} from '../error';
import type { ProtocolErrorMapper } from './adapter';
import { InvalidCompressedRequestBodyError } from './request';

const PREVIOUS_RESPONSE_CONFLICT_MESSAGE = 'previous_response_id matches multiple providers';

// ZodError detail is safe to surface: prettifyError emits only the failing path
// and the expected constraint (e.g. "Expected 'user' | 'assistant' → at
// messages[1].role"), never the received value, so no request content leaks.
function withZodDetail(base: string, error: unknown): string {
  return error instanceof ZodError ? `${base}: ${prettifyError(error)}` : base;
}

export const openAICompletionsErrors: ProtocolErrorMapper = {
  modelUnsupported: (error) =>
    error instanceof ImageInputUnsupportedError
      ? openAIInvalid(501, 'unsupported_feature', 'Image input cannot be represented by this provider')
      : undefined,
  requestError: (error) =>
    error instanceof SyntaxError ||
    error instanceof ZodError ||
    error instanceof InvalidCompressedRequestBodyError ||
    error instanceof OpenAICompletionsTransformError
      ? openAIInvalid(400, 'invalid_request', withZodDetail('Invalid OpenAI Completions request', error))
      : undefined,
  modelNotFound: (message) => openAIInvalid(404, 'model_not_found', message),
  previousResponseConflict: () => openAIInvalid(409, 'previous_response_conflict', PREVIOUS_RESPONSE_CONFLICT_MESSAGE),
  tooLarge: () => openAIInvalid(413, 'request_too_large', 'Request body too large'),
  unsupportedContentEncoding: () => openAIInvalid(415, 'unsupported_content_encoding', 'Unsupported Content-Encoding'),
  unsupported: () =>
    openAIInvalid(501, 'not_implemented', 'Provider does not support OpenAI Completions transform dispatch'),
  provider: openAIProviderError,
  rateLimited: openAIRateLimited,
};

export const openAIResponsesErrors: ProtocolErrorMapper = {
  modelUnsupported(error) {
    if (error instanceof OpenAIResponsesUnsupportedFeatureError) return openAIUnsupported(error.feature);
    return error instanceof ImageInputUnsupportedError ? openAIUnsupported('image_input') : undefined;
  },
  requestError(error) {
    if (error instanceof OpenAIResponsesUnsupportedFeatureError) {
      return openAIUnsupported(error.feature);
    }
    return error instanceof SyntaxError ||
      error instanceof ZodError ||
      error instanceof InvalidCompressedRequestBodyError ||
      error instanceof OpenAIResponsesTransformError
      ? openAIInvalid(400, 'invalid_request', withZodDetail('Invalid OpenAI Responses request', error))
      : undefined;
  },
  modelNotFound: (message) => openAIInvalid(404, 'model_not_found', message),
  previousResponseConflict: () => openAIInvalid(409, 'previous_response_conflict', PREVIOUS_RESPONSE_CONFLICT_MESSAGE),
  tooLarge: () => openAIInvalid(413, 'request_too_large', 'Request body too large'),
  unsupportedContentEncoding: () => openAIInvalid(415, 'unsupported_content_encoding', 'Unsupported Content-Encoding'),
  unsupported: openAIUnsupported,
  provider: openAIProviderError,
  rateLimited: openAIRateLimited,
};

export const anthropicMessagesErrors: ProtocolErrorMapper = {
  modelUnsupported: (error) =>
    error instanceof ImageInputUnsupportedError
      ? anthropicError(501, 'invalid_request_error', 'Image input cannot be represented by this provider')
      : undefined,
  requestError: (error) =>
    error instanceof SyntaxError ||
    error instanceof ZodError ||
    error instanceof InvalidCompressedRequestBodyError ||
    error instanceof AnthropicMessagesTransformError
      ? anthropicError(400, 'invalid_request_error', withZodDetail('Invalid Anthropic Messages request', error))
      : undefined,
  modelNotFound: (message) => anthropicError(404, 'not_found_error', message),
  previousResponseConflict: () => anthropicError(409, 'invalid_request_error', PREVIOUS_RESPONSE_CONFLICT_MESSAGE),
  tooLarge: () => anthropicError(413, 'invalid_request_error', 'Request body too large'),
  unsupportedContentEncoding: () => anthropicError(415, 'invalid_request_error', 'Unsupported Content-Encoding'),
  unsupported: () =>
    anthropicError(501, 'invalid_request_error', 'Provider does not support Anthropic Messages transform dispatch'),
  provider: (error) =>
    genericProviderError(error, (status, message) => anthropicError(status, 'invalid_request_error', message)),
  rateLimited: anthropicRateLimited,
};

export const geminiGenerateContentErrors: ProtocolErrorMapper = {
  modelUnsupported: (error) =>
    error instanceof ImageInputUnsupportedError
      ? geminiError(501, 'UNIMPLEMENTED', 'Image input cannot be represented by this provider')
      : undefined,
  requestError(error) {
    if (error instanceof GeminiInlineDataTooLargeError) {
      return geminiError(413, 'RESOURCE_EXHAUSTED', error.message);
    }
    return error instanceof SyntaxError ||
      error instanceof ZodError ||
      error instanceof InvalidCompressedRequestBodyError ||
      error instanceof GeminiGenerateContentTransformError
      ? geminiError(400, 'INVALID_ARGUMENT', withZodDetail('Invalid Gemini request', error))
      : undefined;
  },
  modelNotFound: (message) => geminiError(404, 'NOT_FOUND', message),
  previousResponseConflict: () => geminiError(409, 'ABORTED', PREVIOUS_RESPONSE_CONFLICT_MESSAGE),
  tooLarge: () => geminiError(413, 'RESOURCE_EXHAUSTED', 'Request body too large'),
  unsupportedContentEncoding: () => geminiError(415, 'INVALID_ARGUMENT', 'Unsupported Content-Encoding'),
  unsupported: () =>
    geminiError(501, 'UNIMPLEMENTED', 'Provider does not support Gemini generateContent transform dispatch'),
  provider: (error) =>
    genericProviderError(error, (status, message) =>
      status === 499 ? geminiError(499, 'CANCELLED', message) : geminiError(status, 'UNAVAILABLE', message),
    ),
  rateLimited: geminiRateLimited,
};

function openAIProviderError(error: unknown): Response | undefined {
  const cause = error instanceof AiSdkProviderError ? error.cause : error;
  const missing = providerNotInstalled(error);
  if (missing !== undefined) {
    return openAIInvalid(503, 'provider_not_installed', missing.message);
  }
  const message = providerMessage(cause);
  if (message === undefined) {
    return undefined;
  }
  if (isAbort(error)) {
    return openAIInvalid(499, 'aborted', message);
  }
  const status = statusCode(cause);
  return openAIInvalid(status ?? 500, status === undefined ? 'internal_error' : 'upstream_error', message);
}

function genericProviderError(
  error: unknown,
  response: (status: 499 | 500 | 503, message: string) => Response,
): Response | undefined {
  const missing = providerNotInstalled(error);
  if (missing !== undefined) {
    return response(503, missing.message);
  }
  const cause = error instanceof AiSdkProviderError ? error.cause : error;
  const message = providerMessage(cause);
  if (message === undefined) return undefined;
  return response(isAbort(error) ? 499 : 500, message);
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
  if (typeof error === 'string') return error;
  if (error === null) return 'Upstream provider error';
  if (typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return undefined;
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode;
  if ('status' in error && typeof error.status === 'number') return error.status;
  if (
    'response' in error &&
    typeof error.response === 'object' &&
    error.response !== null &&
    'status' in error.response &&
    typeof error.response.status === 'number'
  )
    return error.response.status;
  return undefined;
}

function isAbort(error: unknown): boolean {
  const cause = error instanceof AiSdkProviderError ? error.cause : error;
  return cause instanceof Error && cause.name === 'AbortError';
}

function openAIUnsupported(feature: string): Response {
  return Response.json(
    {
      error: {
        code: 'unsupported_feature',
        message: `OpenAI Responses feature is not supported: ${feature}`,
        type: 'unsupported_feature',
      },
    },
    { status: 501 },
  );
}

function openAIInvalid(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message, type: 'invalid_request_error' } }, { status });
}

function anthropicError(status: number, type: 'invalid_request_error' | 'not_found_error', message: string): Response {
  return Response.json({ type: 'error', error: { type, message } }, { status });
}

function geminiError(
  code: 400 | 404 | 409 | 413 | 415 | 429 | 499 | 500 | 501 | 503,
  status:
    | 'ABORTED'
    | 'CANCELLED'
    | 'INVALID_ARGUMENT'
    | 'NOT_FOUND'
    | 'RESOURCE_EXHAUSTED'
    | 'UNAVAILABLE'
    | 'UNIMPLEMENTED',
  message: string,
): Response {
  return Response.json({ error: { code, message, status } }, { status: code });
}

function withRetryAfter(response: Response, retryAfterSeconds: number): Response {
  response.headers.set('retry-after', String(Math.max(1, Math.trunc(retryAfterSeconds))));
  return response;
}

function openAIRateLimited(retryAfterSeconds: number): Response {
  return withRetryAfter(
    Response.json(
      {
        error: {
          code: 'rate_limit_exceeded',
          message: 'All providers for this model are cooling down',
          type: 'rate_limit_error',
        },
      },
      { status: 429 },
    ),
    retryAfterSeconds,
  );
}

function anthropicRateLimited(retryAfterSeconds: number): Response {
  return withRetryAfter(
    Response.json(
      { type: 'error', error: { type: 'rate_limit_error', message: 'All providers for this model are cooling down' } },
      { status: 429 },
    ),
    retryAfterSeconds,
  );
}

function geminiRateLimited(retryAfterSeconds: number): Response {
  return withRetryAfter(
    geminiError(429, 'RESOURCE_EXHAUSTED', 'All providers for this model are cooling down'),
    retryAfterSeconds,
  );
}

// Walks AiSdkProviderError.cause → RetryError.lastError/errors → nested cause
// chains to the terminal APICallError, using APICallError.isInstance as the
// robust guard (works across duplicated @ai-sdk/provider copies).
function findApiCallError(error: unknown, depth = 0): APICallError | undefined {
  if (depth > 6 || error === null || typeof error !== 'object') return undefined;
  if (APICallError.isInstance(error)) return error;
  if (error instanceof AiSdkProviderError) return findApiCallError(error.cause, depth + 1);
  if (RetryError.isInstance(error)) {
    const fromLast = findApiCallError(error.lastError, depth + 1);
    if (fromLast !== undefined) return fromLast;
    for (const inner of error.errors ?? []) {
      const found = findApiCallError(inner, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if ('cause' in error) return findApiCallError((error as { cause?: unknown }).cause, depth + 1);
  return undefined;
}

// The upstream status and Retry-After of a thrown provider error, or undefined
// status when no APICallError is found. Used to decide/size a cooldown.
export function upstreamRetryInfo(error: unknown): { status: number | undefined; retryAfter: string | null } {
  const api = findApiCallError(error);
  if (api === undefined) return { status: undefined, retryAfter: null };
  const headers = api.responseHeaders ?? {};
  const retryAfter = headers['retry-after'] ?? headers['Retry-After'] ?? null;
  return { status: api.statusCode, retryAfter: typeof retryAfter === 'string' ? retryAfter : null };
}
