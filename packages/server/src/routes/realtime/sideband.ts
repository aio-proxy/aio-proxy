import { RealtimeDialError, type RealtimeStyle, type RealtimeTransport } from '@aio-proxy/plugin-sdk';
import type { Context } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import type { WSContext, WSEvents, WSMessageReceive } from 'hono/ws';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { logServerEvent } from '../../server-log';
import { type RealtimeAttachment, sameCallerPrincipal } from './call-store';
import { INTERNAL_CLOSE_CODE, normalizedClose, SHUTDOWN_CLOSE_CODE } from './close-code';
import {
  codexAuthUnavailable,
  invalidCallId,
  isValidCallId,
  realtimeCallBusy,
  realtimeCallNotFound,
  realtimeCallScopeMismatch,
  realtimeDialFailed,
  realtimeUpstreamUnavailable,
  websocketUpgradeRequired,
} from './errors';
import { CODEX_REALTIME_MODEL } from './model';
import { pinnedRealtimeCandidate, selectRealtimeCandidates } from './provider-select';
import type { RealtimeRouteSource } from './source';

export const PRE_OPEN_FRAME_LIMIT = 64;
export const PRE_OPEN_BYTE_LIMIT = 1_048_576;
export const BACKPRESSURE_LIMIT = 1_048_576;
/** What `/v1/realtime` without a `model` query sends upstream. A direct connection
 *  carries no call record, so there is no recorded model to reuse. */
export const DIRECT_DEFAULT_MODEL = 'gpt-realtime';

export async function handleRealtimeSideband(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  style: RealtimeStyle,
): Promise<Response> {
  if (context.req.header('upgrade')?.toLowerCase() !== 'websocket') return websocketUpgradeRequired();

  const prepared = prepare(context, source, style);
  if (prepared instanceof Response) return prepared;

  // Every failing path after this point must release the reservation.
  let dialed: WebSocket;
  try {
    dialed = await prepared.realtime.dial({
      style,
      ...(prepared.callId === undefined ? {} : { callId: prepared.callId }),
      model: prepared.model,
      headers: context.req.raw.headers,
      signal: context.req.raw.signal,
    });
  } catch (error) {
    releaseAttachment(source, prepared);
    const kind = error instanceof RealtimeDialError ? error.kind : 'rejected';
    if (kind === 'aborted') return new Response(null, { status: 499 });
    return kind === 'rejected' ? realtimeDialFailed() : realtimeUpstreamUnavailable();
  }

  if (context.req.raw.signal.aborted) {
    // The downstream went away during the dial; close what just opened.
    closeQuietly(dialed, SHUTDOWN_CLOSE_CODE);
    releaseAttachment(source, prepared);
    return new Response(null, { status: 499 });
  }

  try {
    // The direct `(context, events)` overload of `upgradeWebSocket`, which returns
    // the 101 Response and throws when `server.upgrade` refuses. The middleware
    // overload would instead fall through to `next()` and answer 404.
    return await upgradeWebSocket(context, relayEvents(source, { ...prepared, style, upstream: dialed }));
  } catch {
    // The upgrade did not happen, so nothing will ever tear the upstream down.
    closeQuietly(dialed, INTERNAL_CLOSE_CODE);
    releaseAttachment(source, prepared);
    return realtimeUpstreamUnavailable();
  }
}

function releaseAttachment(source: RealtimeRouteSource, prepared: Prepared): void {
  if (prepared.attachment !== undefined) source.realtimeCalls.release(prepared.attachment.token);
}

type Prepared = {
  readonly callId: string | undefined;
  readonly providerId: string;
  readonly model: string;
  readonly realtime: RealtimeTransport;
  readonly attachment: RealtimeAttachment | undefined;
};

/** All non-mutating validation runs before the reservation, so a rejected request
 *  never leaves a reservation behind. */
function prepare(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  style: RealtimeStyle,
): Prepared | Response {
  if (style === 'realtime-direct') return prepareDirect(context, source);

  const callId = context.req.param('call_id') ?? context.req.query('call_id');
  // A malformed call_id on /v1/realtime is an error, never a silent
  // fall-through to a direct connection.
  if (!isValidCallId(callId)) return invalidCallId();
  const record = source.realtimeCalls.lookup(callId);
  if (record === undefined) return realtimeCallNotFound();
  if (!sameCallerPrincipal(record.owner, callerPrincipal(context))) {
    // The principal is derived from the *presented credential*, so attaching under a
    // different configured key than the create used is this 403 and not a 404. Logged
    // as a failed attach because an operator otherwise has no way to tell it apart
    // from a genuine cross-tenant attempt.
    logServerEvent(source.logger, {
      event: 'realtime.call_failed',
      providerId: record.providerId,
      model: record.model,
      style,
      attemptCount: 0,
      statusCode: 403,
      errorCode: 'realtime_call_scope_mismatch',
    });
    return realtimeCallScopeMismatch();
  }

  const lease = source.acquireProviderSnapshot();
  let realtime: RealtimeTransport;
  try {
    const candidate = pinnedRealtimeCandidate(lease.snapshot, {
      providerId: record.providerId,
      accountId: record.accountId,
      runtimeRevision: record.runtimeRevision,
    });
    if (candidate === undefined) return codexAuthUnavailable();
    realtime = candidate.realtime;
  } finally {
    lease.release();
  }

  // Reserve last: a synchronous check-and-set in one Bun isolate needs no mutex.
  const attachment = source.realtimeCalls.reserve(callId);
  if (attachment === undefined) return realtimeCallBusy();
  return { callId, providerId: record.providerId, model: record.model, realtime, attachment };
}

/** A direct connection has no call record, so nothing is reserved and nothing is
 *  pinned: selection is the ordinary candidate order. */
function prepareDirect(context: Context<CallerPrincipalEnv>, source: RealtimeRouteSource): Prepared | Response {
  const requested = context.req.query('model');
  const lease = source.acquireProviderSnapshot();
  try {
    // Selection still matches on the normalized model, but `realtime-direct`
    // sends the ORIGINALLY REQUESTED model upstream, defaulting to
    // `gpt-realtime`. Substituting the Codex model would diverge from Codex.
    const [candidate] = selectRealtimeCandidates(lease.snapshot, {
      requested: requested ?? DIRECT_DEFAULT_MODEL,
      normalized: CODEX_REALTIME_MODEL,
    });
    if (candidate === undefined) return realtimeUpstreamUnavailable();
    return {
      callId: undefined,
      providerId: candidate.provider.id,
      model: requested === undefined || requested.length === 0 ? DIRECT_DEFAULT_MODEL : requested,
      realtime: candidate.realtime,
      attachment: undefined,
    };
  } finally {
    lease.release();
  }
}

type RelayInput = Prepared & { readonly style: RealtimeStyle; readonly upstream: WebSocket };

type Teardown = (code: number, reason?: string, origin?: 'downstream' | 'upstream' | 'proxy') => void;

function relayEvents(source: RealtimeRouteSource, input: RelayInput): WSEvents {
  const upstream = input.upstream;
  upstream.binaryType = 'arraybuffer';
  const pending: (string | ArrayBuffer)[] = [];
  let pendingBytes = 0;
  let downstream: WSContext | undefined;
  let torndown = false;

  // One teardown, safe from either side's close, from shutdown, and from hangup.
  const teardown: Teardown = (code, reason, origin = 'proxy') => {
    if (torndown) return;
    torndown = true;
    // Normalized once and applied to BOTH directions: an over-long reason forwarded
    // upstream does not throw on the server side, it silently truncates, and a cut
    // landing mid-sequence makes Bun discard the frame and substitute 1007 — losing
    // the origin's close code in the process.
    const normalized = normalizedClose(code, reason);
    closeQuietly(upstream, normalized.code, normalized.reason);
    try {
      downstream?.close(normalized.code, normalized.reason);
    } catch {}
    if (input.attachment !== undefined) {
      source.realtimeCalls.release(input.attachment.token);
      // A sideband close ends the call; a *failed attach* does not, so only this
      // path removes the record.
      if (input.callId !== undefined) source.realtimeCalls.remove(input.callId);
    }
    logServerEvent(source.logger, {
      event: 'realtime.sideband_closed',
      callId: input.callId ?? '',
      providerId: input.providerId,
      model: input.model,
      style: input.style,
      closeCode: normalized.code,
      origin,
    });
  };

  input.attachment?.onClose((code) => teardown(code, undefined, 'proxy'));

  upstream.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
    const data = event.data;
    if (downstream === undefined) {
      // Pre-open buffer: 64 frames or 1 MiB, whichever comes first.
      pendingBytes += typeof data === 'string' ? data.length : data.byteLength;
      if (pending.length >= PRE_OPEN_FRAME_LIMIT || pendingBytes > PRE_OPEN_BYTE_LIMIT) {
        teardown(INTERNAL_CLOSE_CODE, undefined, 'upstream');
        return;
      }
      pending.push(data);
      return;
    }
    sendDownstream(downstream, data, teardown);
  });
  upstream.addEventListener('close', (event: CloseEvent) => teardown(event.code, event.reason, 'upstream'));
  // Bun always follows `error` with `close`, so the close handler is the single
  // teardown trigger and this listener only prevents an unhandled event.
  upstream.addEventListener('error', () => {});

  return {
    onOpen(_event: Event, ws: WSContext) {
      downstream = ws;
      if (torndown) {
        try {
          ws.close(INTERNAL_CLOSE_CODE);
        } catch {}
        return;
      }
      logServerEvent(source.logger, {
        event: 'realtime.sideband_opened',
        callId: input.callId ?? '',
        providerId: input.providerId,
        model: input.model,
        style: input.style,
      });
      for (const data of pending.splice(0)) sendDownstream(ws, data, teardown);
      pendingBytes = 0;
    },
    onMessage(event: MessageEvent<WSMessageReceive>) {
      const data = event.data;
      // Hono's Bun adapter already normalized a binary frame to `message.buffer`,
      // an exclusive Buffer on Bun 1.4.2. Forward it as-is: copying would be the
      // fix only if Bun ever shared a receive buffer, and Task 11's byte-length
      // test is what would catch that.
      if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
        teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
        return;
      }
      if (upstream.bufferedAmount > BACKPRESSURE_LIMIT) {
        teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
        return;
      }
      try {
        upstream.send(data);
      } catch {
        teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
      }
    },
    onClose(event: CloseEvent) {
      teardown(event.code, event.reason, 'downstream');
    },
  };
}

/** `WSContext.send` discards Bun's backpressure result and exposes no `drain`, so
 *  the real queued byte count comes from the underlying `ServerWebSocket`. The origin
 *  is `proxy`: neither peer misbehaved, the proxy's own ceiling tripped. */
function sendDownstream(ws: WSContext, data: string | ArrayBuffer, teardown: Teardown): void {
  const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
  if ((raw?.getBufferedAmount?.() ?? 0) > BACKPRESSURE_LIMIT) {
    teardown(INTERNAL_CLOSE_CODE);
    return;
  }
  try {
    ws.send(data);
  } catch {
    teardown(INTERNAL_CLOSE_CODE);
  }
}

function closeQuietly(socket: WebSocket, code: number, reason?: string): void {
  try {
    socket.close(code, reason);
  } catch {}
}
