import type { ProtocolErrorMapper } from '../adapter';

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
  requestError: (error) => (error instanceof Error ? json(error.message, 'invalid_request_error', 400) : undefined),
  modelNotFound: (message) => json(message, 'not_found_error', 404),
  previousResponseConflict: () => json('Not supported for evaluation', 'invalid_request_error', 400),
  tooLarge: () => json('Request body is too large', 'invalid_request_error', 413),
  unsupportedContentEncoding: () => json('Unsupported content encoding', 'invalid_request_error', 415),
  unsupported: (feature) => json(`Unsupported: ${feature}`, 'not_supported_error', 501),
  provider: () => undefined,
  rateLimited: (retryAfterSeconds) =>
    new Response(body('Rate limited', 'rate_limit_error'), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    }),
};
