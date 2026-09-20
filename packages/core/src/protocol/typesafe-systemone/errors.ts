import type { ProtocolErrorMapper } from '../adapter';
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
  // Selective by design: `parseSystemOneBody` funnels every inbound rejection it
  // can see -- bad media type, unreadable body, schema violations -- through
  // `SystemOneParseError`, whose message is written for callers. Anything else
  // reaching here is an egress failure or a bug of ours, so it must fall through
  // to its own handler instead of becoming a 400 that blames the caller and
  // echoes an internal message back to them.
  requestError: (error) =>
    error instanceof SystemOneParseError ? json(error.message, 'invalid_request_error', 400) : undefined,
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
