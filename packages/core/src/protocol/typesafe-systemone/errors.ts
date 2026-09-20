import type { ProtocolErrorMapper } from '../adapter';
import {
  InvalidCompressedRequestBodyError,
  RequestBodyTooLargeError,
  UnsupportedContentEncodingError,
} from '../request';
import { SystemOneParseError } from './parse';

// System One's own client parses `{ message, error_type }`, so none of the shared
// OpenAI-envelope helpers in `../errors` are reusable here. That file is also
// already at the repo's 500-line ceiling, so the mapper lives beside its adapter.
const body = (message: string, errorType: string): string => JSON.stringify({ message, error_type: errorType });

const json = (message: string, errorType: string, status: number): Response =>
  new Response(body(message, errorType), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const systemOneErrors: ProtocolErrorMapper = {
  // Selective by design: the caller's fault arrives as `SystemOneParseError` (bad
  // media type, schema violations) or `InvalidCompressedRequestBodyError` (a body
  // whose bytes are not the encoding it declared), and both answer 400 here.
  // `UnsupportedContentEncodingError` and `RequestBodyTooLargeError` deliberately
  // escape unwrapped so the pipeline can answer 415 and 413 instead. Anything else
  // reaching here is an egress failure or a bug of ours, so it must fall through
  // to its own handler instead of becoming a 400 that blames the caller and
  // echoes an internal message back to them.
  requestError: (error) => {
    if (error instanceof SystemOneParseError) return json(error.message, 'invalid_request_error', 400);
    return error instanceof InvalidCompressedRequestBodyError
      ? json('Invalid compressed request body', 'invalid_request_error', 400)
      : undefined;
  },
  modelNotFound: (message) => json(message, 'not_found_error', 404),
  previousResponseConflict: () => json('Not supported for evaluation', 'invalid_request_error', 400),
  tooLarge: () => json('Request body is too large', 'invalid_request_error', 413),
  unsupportedContentEncoding: () => json('Unsupported content encoding', 'invalid_request_error', 415),
  unsupported: (feature) => json(`Unsupported: ${feature}`, 'not_supported_error', 501),
  // Every throw from an attempt must map to a response: `handleAttemptError`
  // rethrows what it cannot map, which exits the candidate loop, so a request
  // whose next candidate is healthy would die here and no cooldown would be
  // written for the provider that just failed. The two body-read rejections are
  // the deliberate exception -- the pipeline owns them and answers 415 and 413.
  //
  // The message is a constant. An attempt failure is an upstream fault or a bug
  // of ours, and neither is the caller's to read; the cause reaches the operator
  // through the attempt log, as it does for a failed discovery. No status is
  // extracted from the error: the pipeline already calls `upstreamRetryInfo` to
  // size the cooldown, and an upstream `retry-after` describes one provider
  // rather than this route, so echoing it here would misdescribe the failure. A
  // single upstream 429 therefore maps to 502 and falls back like any other
  // candidate failure; `rateLimited` stays reserved for the pre-attempt state
  // where every candidate is already cooling down and none was tried.
  provider: (error) => {
    if (error instanceof UnsupportedContentEncodingError || error instanceof RequestBodyTooLargeError) {
      return undefined;
    }
    return error instanceof Error && error.name === 'AbortError'
      ? json('Evaluation cancelled', 'cancelled_error', 499)
      : json('Upstream evaluation provider failed', 'upstream_error', 502);
  },
  rateLimited: (retryAfterSeconds) =>
    new Response(body('Rate limited', 'rate_limit_error'), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    }),
};
