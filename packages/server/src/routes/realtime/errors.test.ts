import { expect, test } from 'bun:test';

import {
  codexAuthUnavailable,
  invalidCallId,
  isValidCallId,
  realtimeBodyTooLarge,
  realtimeCallBusy,
  realtimeCallNotFound,
  realtimeCallScopeMismatch,
  realtimeCapabilityNotSupported,
  realtimeDialFailed,
  realtimeInvalidOffer,
  realtimeUnsupportedMediaType,
  realtimeUpstreamUnavailable,
  websocketUpgradeRequired,
} from './errors';

test('every realtime error body carries the four-field OpenAI error shape', async () => {
  const response = realtimeCallBusy();

  expect(response.status).toBe(409);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({
    error: {
      message: 'A sideband attachment is already active for this call.',
      type: 'invalid_request_error',
      param: null,
      code: 'realtime_call_busy',
    },
  });
});

test('the status, type, and code of each distinct failure class stay pinned', async () => {
  const rows = [
    [realtimeCapabilityNotSupported(), 501, 'not_supported_error', 'realtime_capability_not_supported'],
    [realtimeDialFailed(), 502, 'api_error', 'realtime_dial_failed'],
    [realtimeUpstreamUnavailable(), 503, 'api_error', 'realtime_upstream_unavailable'],
  ] as const;

  for (const [response, status, type, code] of rows) {
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: { type: string; code: string; param: null } };
    expect(body.error.type).toBe(type);
    expect(body.error.code).toBe(code);
    expect(body.error.param).toBeNull();
  }
});

test('every row of the spec error table has a helper with the four-field shape', async () => {
  const rows = [
    [invalidCallId(), 400, 'invalid_request_error', 'invalid_call_id'],
    [realtimeInvalidOffer('bad offer'), 400, 'invalid_request_error', 'realtime_invalid_offer'],
    [realtimeCallScopeMismatch(), 403, 'invalid_request_error', 'realtime_call_scope_mismatch'],
    [realtimeCallNotFound(), 404, 'invalid_request_error', 'realtime_call_not_found'],
    [realtimeCallBusy(), 409, 'invalid_request_error', 'realtime_call_busy'],
    [realtimeBodyTooLarge(), 413, 'invalid_request_error', 'realtime_body_too_large'],
    [realtimeUnsupportedMediaType(), 415, 'invalid_request_error', 'realtime_unsupported_media_type'],
    [websocketUpgradeRequired(), 426, 'invalid_request_error', 'websocket_upgrade_required'],
    [realtimeCapabilityNotSupported(), 501, 'not_supported_error', 'realtime_capability_not_supported'],
    [realtimeDialFailed(), 502, 'api_error', 'realtime_dial_failed'],
    [codexAuthUnavailable(), 503, 'api_error', 'codex_auth_unavailable'],
    [realtimeUpstreamUnavailable(), 503, 'api_error', 'realtime_upstream_unavailable'],
  ] as const;

  for (const [response, status, type, code] of rows) {
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'param', 'type']);
    expect(body.error['type']).toBe(type);
    expect(body.error['code']).toBe(code);
    expect(body.error['param']).toBeNull();
    expect(typeof body.error['message']).toBe('string');
  }
});

test('the 426 carries the Upgrade header a client needs to retry correctly', () => {
  expect(websocketUpgradeRequired().headers.get('upgrade')).toBe('websocket');
});

/** Task 9 calls a helper on more than one request, and a `Response` body is single-use. */
test('each helper call yields an independently readable response', async () => {
  const first = realtimeCallNotFound();
  const second = realtimeCallNotFound();

  expect(first).not.toBe(second);
  await first.json();
  expect(((await second.json()) as { error: { code: string } }).error.code).toBe('realtime_call_not_found');
});

test('the call id pattern rejects path traversal, oversize, and empty ids', () => {
  expect(isValidCallId('call_abc-123')).toBe(true);
  expect(isValidCallId('a'.repeat(128))).toBe(true);
  expect(isValidCallId('a'.repeat(129))).toBe(false);
  expect(isValidCallId('')).toBe(false);
  expect(isValidCallId(undefined)).toBe(false);
  expect(isValidCallId('../secrets')).toBe(false);
  expect(isValidCallId('call abc')).toBe(false);
});
