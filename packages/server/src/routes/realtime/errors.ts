export const REALTIME_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function isValidCallId(value: string | undefined): value is string {
  return value !== undefined && REALTIME_CALL_ID_PATTERN.test(value);
}

type RealtimeErrorType = 'invalid_request_error' | 'not_supported_error' | 'api_error';

export function realtimeError(status: number, type: RealtimeErrorType, code: string, message: string): Response {
  return Response.json({ error: { message, type, param: null, code } }, { status });
}

export function invalidCallId(): Response {
  return realtimeError(400, 'invalid_request_error', 'invalid_call_id', 'The call_id is not a valid identifier.');
}

export function realtimeInvalidOffer(message: string): Response {
  return realtimeError(400, 'invalid_request_error', 'realtime_invalid_offer', message);
}

export function realtimeCallScopeMismatch(): Response {
  return realtimeError(
    403,
    'invalid_request_error',
    'realtime_call_scope_mismatch',
    'This call belongs to a different caller.',
  );
}

export function realtimeCallNotFound(): Response {
  return realtimeError(
    404,
    'invalid_request_error',
    'realtime_call_not_found',
    'No active realtime call matches this call_id.',
  );
}

export function realtimeCallBusy(): Response {
  return realtimeError(
    409,
    'invalid_request_error',
    'realtime_call_busy',
    'A sideband attachment is already active for this call.',
  );
}

export function realtimeBodyTooLarge(): Response {
  return realtimeError(
    413,
    'invalid_request_error',
    'realtime_body_too_large',
    'The realtime offer exceeds the 16 MiB limit.',
  );
}

export function realtimeUnsupportedMediaType(): Response {
  return realtimeError(
    415,
    'invalid_request_error',
    'realtime_unsupported_media_type',
    'A realtime offer must be application/sdp, text/plain, application/json, or multipart/form-data.',
  );
}

export function websocketUpgradeRequired(): Response {
  const response = realtimeError(
    426,
    'invalid_request_error',
    'websocket_upgrade_required',
    'This endpoint requires a WebSocket upgrade.',
  );
  response.headers.set('upgrade', 'websocket');
  return response;
}

export function realtimeCapabilityNotSupported(): Response {
  return realtimeError(
    501,
    'not_supported_error',
    'realtime_capability_not_supported',
    'This realtime capability is not available through the configured upstream.',
  );
}

/** The upstream handshake status is unobservable from a client `WebSocket`, so a
 *  rejected dial is always this one error — never a mapped upstream 404 or 501. */
export function realtimeDialFailed(): Response {
  return realtimeError(502, 'api_error', 'realtime_dial_failed', 'The upstream refused the sideband handshake.');
}

export function codexAuthUnavailable(): Response {
  return realtimeError(
    503,
    'api_error',
    'codex_auth_unavailable',
    'The account that created this call is no longer available.',
  );
}

export function realtimeUpstreamUnavailable(): Response {
  return realtimeError(
    503,
    'api_error',
    'realtime_upstream_unavailable',
    'No realtime upstream is currently available.',
  );
}
