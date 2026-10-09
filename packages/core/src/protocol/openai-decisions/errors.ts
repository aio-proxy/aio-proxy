import { Experimental_EvaluationUnsupportedQuestionTypeError } from 'ai';
import { ZodError } from 'zod';

import type { ProtocolErrorMapper } from '../adapter';
import { openAIInvalid, openAIProviderError, openAIRateLimited } from '../errors';
import { InvalidCompressedRequestBodyError, InvalidContentLengthError } from '../request/index';

export const openAIDecisionsErrors: ProtocolErrorMapper = {
  requestError: (error) =>
    error instanceof ZodError ||
    error instanceof SyntaxError ||
    error instanceof InvalidCompressedRequestBodyError ||
    error instanceof InvalidContentLengthError
      ? openAIInvalid(400, 'invalid_request', 'Invalid OpenAI Decisions request')
      : undefined,
  modelNotFound: (message) => openAIInvalid(404, 'model_not_found', message),
  previousResponseConflict: () => openAIInvalid(409, 'previous_response_conflict', 'Conflicting previous response'),
  tooLarge: () => openAIInvalid(413, 'request_too_large', 'Request body too large'),
  unsupportedContentEncoding: () => openAIInvalid(415, 'unsupported_content_encoding', 'Unsupported Content-Encoding'),
  unsupported: (feature) =>
    openAIInvalid(501, 'unsupported_feature', `Provider cannot serve OpenAI Decisions: ${feature}`),
  provider: (error) =>
    Experimental_EvaluationUnsupportedQuestionTypeError.isInstance(error)
      ? openAIInvalid(501, 'unsupported_feature', 'Provider does not support this evaluation question type')
      : openAIProviderError(error),
  rateLimited: openAIRateLimited,
};
