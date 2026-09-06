import { RealtimeDialError, type RealtimeStyle, type RealtimeTransport } from '@aio-proxy/plugin-sdk';
import type { Context } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import type { WSContext, WSEvents, WSMessageReceive } from 'hono/ws';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { logServerEvent } from '../../server-log';
import { withoutCallerCredentials } from '../../server/api-key-auth';
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
  realtimeInvalidModel,
  realtimeUpstreamUnavailable,
  websocketUpgradeRequired,
} from './errors';
import { CODEX_REALTIME_MODEL, MAX_REALTIME_MODEL_LENGTH } from './model';
import { pinnedRealtimeCandidate, selectRealtimeCandidates } from './provider-select';
import type { RealtimeRouteSource } from './source';

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
      // `RealtimeDialInput` promises the plugin that caller credentials are already gone,
      // and a plugin that forwards headers selectively relies on it. The auth middleware
      // only delivers that on its keyed branch: with no configured key,
      // `authenticateStaticOrAnonymous` admits the request without stripping, so the
      // caller's own `Authorization` would reach the plugin here. Stripped at the boundary
      // that makes the promise, so it holds on both branches.
      headers: withoutCallerCredentials(context.req.raw.headers),
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

  // The dial resolves from the upstream's `open`, so an upstream that accepts the
  // handshake and drops the socket at once resolves it too — and its `close` is
  // dispatched before `createRelay` can bind a listener for it, leaving nothing to run
  // `teardown`. Checked here rather than inside the relay because this is the last point
  // at which the failure can still be a response: after the upgrade the caller would get
  // a 101 followed by an opaque close, and `teardown` would gain a second pre-open
  // trigger. Nothing can be dispatched between this check and the binding — both run in
  // the same synchronous block — so together they cover the whole window.
  if (dialed.readyState === WebSocket.CLOSING || dialed.readyState === WebSocket.CLOSED) {
    releaseAttachment(source, prepared);
    // The plugin maps every non-`1006` dial close to `rejected`; an upstream that hangs
    // up on its own socket is the same refusal, just observed one step later.
    return realtimeDialFailed();
  }

  // Past this point the relay owns the reservation: `teardown` is the only release.
  const relay = createRelay(source, { ...prepared, style, upstream: dialed });
  try {
    // The direct `(context, events)` overload of `upgradeWebSocket`, which returns
    // the 101 Response and throws when `server.upgrade` refuses. The middleware
    // overload would instead fall through to `next()` and answer 404.
    return await upgradeWebSocket(context, relay.events);
  } catch {
    // A refused upgrade must leave the record intact: the call is still valid and the
    // owner's next attach has to find it. Routed through `teardown` rather than closing
    // and releasing here so the reservation has exactly one owner — `teardown` closes
    // the upstream, releases, and keys the record deletion and the `sideband_closed`
    // log on `onOpen` having fired, which it has not. Its `torndown` latch also makes
    // the upstream close event this triggers a no-op.
    relay.teardown(INTERNAL_CLOSE_CODE, undefined, 'proxy');
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
  // Bounded for the same reason as the create body's `model`: this string is sent
  // upstream and recorded in both sideband log entries, and only the parse boundary
  // sees it before it fans out.
  if (requested !== undefined && requested.length > MAX_REALTIME_MODEL_LENGTH) return realtimeInvalidModel();
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

type Relay = { readonly events: WSEvents; readonly teardown: Teardown };

/** Returns the teardown alongside the events so the caller can run the one teardown
 *  itself when the upgrade it was built for never happens. */
function createRelay(source: RealtimeRouteSource, input: RelayInput): Relay {
  const upstream = input.upstream;
  upstream.binaryType = 'arraybuffer';
  let downstream: WSContext | undefined;
  let opened = false;
  let torndown = false;

  // One teardown, safe from either side's close, from shutdown, and from hangup.
  const teardown: Teardown = (code, reason, origin = 'proxy') => {
    if (torndown) return;
    torndown = true;
    // Normalized once and applied to BOTH directions. On the downstream -> upstream
    // leg this is load-bearing: the upstream is a client `WebSocket`, whose `close()`
    // throws `InvalidAccessError` on a reserved code and `SyntaxError` over 123 UTF-8
    // bytes, so an unnormalized forward would abort the frame entirely. On the
    // upstream -> downstream leg it only bounds what the proxy itself emits; see
    // `close-code.ts` for what Bun has already destroyed by the time a reason arrives.
    const normalized = normalizedClose(code, reason);
    closeQuietly(upstream, normalized.code, normalized.reason);
    try {
      downstream?.close(normalized.code, normalized.reason);
    } catch {}
    if (input.attachment !== undefined) source.realtimeCalls.release(input.attachment.token);
    // A sideband that never opened is a *failed attach*: the call is still live
    // upstream-side from the caller's point of view, so the record must survive for
    // the owner's next attempt, and no `sideband_closed` may be logged against a
    // sideband that was never opened.
    if (!opened) return;
    if (input.attachment !== undefined && input.callId !== undefined) {
      source.realtimeCalls.remove(input.callId);
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
    if (downstream === undefined) {
      // Unreachable in Bun 1.4.2: `websocket.open` runs synchronously inside
      // `server.upgrade()`, in the same tick as the dial's resumption, and a
      // WebSocket event needs an event-loop turn — so there is no window in which
      // the upstream can speak before `onOpen`. The listener is still bound this
      // early on purpose: a Bun client `WebSocket` silently discards frames
      // delivered with no `message` listener, so binding late would trade a loud
      // failure for lost bytes. If the ordering ever changes, the relay fails
      // closed instead of dropping a frame.
      teardown(INTERNAL_CLOSE_CODE, undefined, 'upstream');
      return;
    }
    sendDownstream(downstream, event.data, teardown);
  });
  upstream.addEventListener('close', (event: CloseEvent) => teardown(event.code, event.reason, 'upstream'));
  // Bun always follows `error` with `close`, so the close handler is the single
  // teardown trigger and this listener only prevents an unhandled event.
  upstream.addEventListener('error', () => {});

  return {
    teardown,
    events: {
      onOpen(_event: Event, ws: WSContext) {
        downstream = ws;
        if (torndown) {
          try {
            ws.close(INTERNAL_CLOSE_CODE);
          } catch {}
          return;
        }
        opened = true;
        logServerEvent(source.logger, {
          event: 'realtime.sideband_opened',
          callId: input.callId ?? '',
          providerId: input.providerId,
          model: input.model,
          style: input.style,
        });
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
