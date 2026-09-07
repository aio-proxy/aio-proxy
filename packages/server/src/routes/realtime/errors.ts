export const REALTIME_CALL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

declare const validatedCallId: unique symbol;

/** A call ID that has passed `REALTIME_CALL_ID_PATTERN`. Assignable to `string`, so
 *  callers pass it straight to `RealtimeCallStore.lookup`. */
export type RealtimeCallId = string & { readonly [validatedCallId]: true };

/** Narrowing to a branded subtype rather than to `string` keeps the *false* branch
 *  honest: TypeScript subtracts the asserted type from the parameter's declared type,
 *  so `value is string` on `string | undefined` would leave the rejecting branch typed
 *  `undefined` while it actually holds an attacker-controlled string such as
 *  `../secrets`. A brand cannot be subtracted, so the rejecting branch stays
 *  `string | undefined` and the accepting branch is still usable as a string. */
export function isValidCallId(value: string | undefined): value is RealtimeCallId {
  return value !== undefined && REALTIME_CALL_ID_PATTERN.test(value);
}

/** Compile-time guard for the paragraph above. `isValidCallId` narrowing to the brand
 *  leaves the rejecting branch `string | undefined`, so this assignment is an error and the
 *  directive is used. Widening the predicate back to `value is string` types the branch
 *  `undefined`, the assignment becomes legal, and the build fails with
 *  `TS2578: Unused '@ts-expect-error' directive`. No runtime test can observe a static
 *  type, so without this the unsound signature could return unnoticed. */
function assertRejectingBranchKeepsTheString(value: string | undefined): undefined {
  if (isValidCallId(value)) return undefined;
  // @ts-expect-error -- `value` must still be `string | undefined` here, not `undefined`.
  const stillAString: undefined = value;
  return stillAString;
}
// Referenced only so the guard above is not pruned as an unused declaration.
void assertRejectingBranchKeepsTheString;

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

/** Rejected rather than truncated. A caller-supplied model id is echoed into
 *  `realtime.call_failed`, which the log bridge maps to `error`, so an unbounded one is
 *  both a disclosure channel — an SDP offer pasted into `model` — and a log-amplification
 *  lever. Truncating would bound the volume but could also silently rewrite the id into a
 *  prefix matching a *different* advertised model, so the request is refused instead. */
export function realtimeInvalidModel(): Response {
  return realtimeError(
    400,
    'invalid_request_error',
    'realtime_invalid_model',
    'The requested realtime model id exceeds 128 characters.',
  );
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

/** The design spec's table prescribed no mapping for an upstream failure because it had the
 *  create's `4xx` relayed verbatim, which the 2026-09-06 ruling reversed. The upstream status
 *  survives — it is the only part of the upstream reply a client can act on — while the message
 *  is the proxy's own, since the upstream's was observed echoing the caller's SDP offer back.
 *  `code` matches the `upstream_rejected` the create log already emits at this site. */
export function realtimeUpstreamRejected(status: number): Response {
  return realtimeError(
    status,
    'invalid_request_error',
    'upstream_rejected',
    'The realtime upstream rejected this request.',
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
