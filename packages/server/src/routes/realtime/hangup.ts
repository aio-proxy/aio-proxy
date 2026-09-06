import type { Context } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { isInboundAbort } from '../../route-observation';
import { logServerEvent } from '../../server-log';
import { sameCallerPrincipal } from './call-store';
import { NORMAL_CLOSE_CODE } from './close-code';
import {
  codexAuthUnavailable,
  invalidCallId,
  isValidCallId,
  realtimeCallNotFound,
  realtimeCallScopeMismatch,
  realtimeUpstreamUnavailable,
} from './errors';
import { pinnedRealtimeCandidate } from './provider-select';
import type { RealtimeRouteSource } from './source';

export async function handleRealtimeHangup(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
): Promise<Response> {
  const callId = context.req.param('call_id');
  if (!isValidCallId(callId)) return invalidCallId();
  const record = source.realtimeCalls.lookup(callId);
  if (record === undefined) return realtimeCallNotFound();
  if (!sameCallerPrincipal(record.owner, callerPrincipal(context))) {
    // Same reason as the sideband's 403: the principal identifies the presented
    // credential, so a caller hanging up under a different configured key than the
    // create used lands here. Logged so it is diagnosable rather than a bare status.
    logScopeMismatch(source, record.providerId, record.model, record.style);
    return realtimeCallScopeMismatch();
  }

  const lease = source.acquireProviderSnapshot();
  let response: Response;
  try {
    // Hangup uses the call's pinned account, never the current best candidate.
    const candidate = pinnedRealtimeCandidate(lease.snapshot, {
      providerId: record.providerId,
      accountId: record.accountId,
      runtimeRevision: record.runtimeRevision,
    });
    if (candidate === undefined) return codexAuthUnavailable();
    response = await candidate.realtime.fetch(
      new Request(context.req.raw.url, { method: 'POST', signal: context.req.raw.signal }),
    );
  } catch (error) {
    if (isInboundAbort(error, context.req.raw.signal)) return new Response(null, { status: 499 });
    return realtimeUpstreamUnavailable();
  } finally {
    lease.release();
  }

  // Hangup stays available while a sideband is live; a 2xx closes it with 1000
  // and deletes the record. A non-2xx leaves both untouched. The order matters:
  // `closeAttachment` looks the record up, so removing first would silently skip
  // the live socket's teardown.
  if (response.ok) {
    source.realtimeCalls.closeAttachment(callId, NORMAL_CLOSE_CODE);
    source.realtimeCalls.remove(callId);
  }
  return response;
}

function logScopeMismatch(source: RealtimeRouteSource, providerId: string, model: string, style: string): void {
  logServerEvent(source.logger, {
    event: 'realtime.call_failed',
    providerId,
    model,
    style,
    attemptCount: 0,
    statusCode: 403,
    errorCode: 'realtime_call_scope_mismatch',
  });
}
