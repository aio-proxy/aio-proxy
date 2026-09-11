import { prettifyError, ZodError } from 'zod';

import {
  OPENAI_VIDEO_UNSUPPORTED_FEATURES,
  OpenAIVideosInvalidRequestError,
  OpenAIVideosUnsupportedFeatureError,
} from '../../error';
import type { ProtocolErrorMapper } from '../adapter';
import { openAIInvalid, openAIProviderError, openAIRateLimited } from '../errors';
import { InvalidCompressedRequestBodyError, RequestBodyIdleTimeoutError } from '../request';

const PREVIOUS_RESPONSE_CONFLICT_MESSAGE = 'previous_response_id matches multiple providers';
const VIDEO_NOT_IMPLEMENTED_MESSAGE = 'No configured provider can generate videos for this model';
const VIDEO_UNSUPPORTED_FEATURES = new Set<string>(OPENAI_VIDEO_UNSUPPORTED_FEATURES);

export const openAIVideosErrors: ProtocolErrorMapper = {
  requestError: (error) => {
    if (error instanceof OpenAIVideosUnsupportedFeatureError) return openAIVideosUnsupported(error.feature);
    if (error instanceof OpenAIVideosInvalidRequestError) {
      if (error.param === 'content_type') {
        return openAIInvalid(415, 'invalid_request', 'Unsupported Content-Type');
      }
      return openAIInvalid(400, 'invalid_request', error.message);
    }
    if (error instanceof RequestBodyIdleTimeoutError) return openAIInvalid(408, 'request_timeout', error.message);
    if (error instanceof Error && error.name === 'AbortError') return openAIInvalid(499, 'aborted', error.message);
    return error instanceof SyntaxError ||
      error instanceof ZodError ||
      error instanceof InvalidCompressedRequestBodyError
      ? openAIInvalid(400, 'invalid_request', withZodDetail('Invalid OpenAI Videos request', error))
      : undefined;
  },
  modelNotFound: (message) => openAIInvalid(404, 'model_not_found', message),
  previousResponseConflict: () => openAIInvalid(409, 'previous_response_conflict', PREVIOUS_RESPONSE_CONFLICT_MESSAGE),
  tooLarge: () => openAIInvalid(413, 'request_too_large', 'Request body too large'),
  unsupportedContentEncoding: () => openAIInvalid(415, 'unsupported_content_encoding', 'Unsupported Content-Encoding'),
  unsupported: openAIVideosUnsupported,
  provider: openAIProviderError,
  rateLimited: openAIRateLimited,
};

function openAIVideosUnsupported(feature: string): Response {
  if (feature === 'video') return openAIInvalid(501, 'not_implemented', VIDEO_NOT_IMPLEMENTED_MESSAGE);
  return VIDEO_UNSUPPORTED_FEATURES.has(feature)
    ? openAIInvalid(501, 'unsupported_feature', `OpenAI Videos feature is not supported: ${feature}`)
    : openAIInvalid(501, 'not_implemented', 'Provider does not support OpenAI Videos transform dispatch');
}

function withZodDetail(base: string, error: unknown): string {
  return error instanceof ZodError ? `${base}: ${prettifyError(error)}` : base;
}
