import { RealtimeDialError, type RealtimeStyle, type RealtimeTransport } from '@aio-proxy/plugin-sdk';
import type { Context } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import type { WSEvents } from 'hono/ws';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import type { ProviderRouteSnapshot } from '../../runtime';
import { logServerEvent } from '../../server-log';
import { nativeUpgradeRequest, withoutCallerCredentials } from '../../server/api-key-auth';
import { type RealtimeAttachment, sameCallerPrincipal } from './call-store';
import { INTERNAL_CLOSE_CODE, SHUTDOWN_CLOSE_CODE } from './close-code';
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
import { MAX_REALTIME_MODEL_LENGTH, normalizeRealtimeModel } from './model';
import { pinnedRealtimeCandidate, selectRealtimeCandidates } from './provider-select';
import { closeQuietly, createRelay } from './relay';
import type { RealtimeRouteSource } from './source';

/** What `/v1/realtime` without a `model` query sends upstream. A direct connection
 *  carries no call record, so there is no recorded model to reuse. */
export const DIRECT_DEFAULT_MODEL = 'gpt-realtime';
/** Same bound as the create's, and for the same reason: each attempt costs a full dial
 *  deadline, so an unbounded list would let one request hold a snapshot lease for
 *  `candidates * 10 s`. A pinned attach has exactly one candidate regardless. */
export const MAX_DIAL_ATTEMPTS = 2;

export async function handleRealtimeSideband(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  style: RealtimeStyle,
): Promise<Response> {
  if (context.req.header('upgrade')?.toLowerCase() !== 'websocket') return websocketUpgradeRequired();

  const lease = source.acquireProviderSnapshot();
  let prepared: Prepared;
  let dialed: Dialed | Response;
  try {
    const result = prepare(context, source, style, lease.snapshot);
    if (result instanceof Response) return result;
    prepared = result;
    dialed = await dialCandidates(context, prepared, style);
  } finally {
    // Held across the dial, not merely across selection: `dial` reads the provider's
    // credential asynchronously through the credential port, which resolves the account row
    // out of the repository. Releasing after extracting the transport let account-removal
    // finalization observe a drained snapshot and delete that row mid-dial, so a request that
    // had already passed the pin check failed with `CredentialAccountMissingError`. This is
    // the same window signaling and hangup already hold, and it ends here rather than at the
    // relay's teardown: the relay is a long-lived socket, and holding a lease for its lifetime
    // would stall provider reload indefinitely. The dial is bounded by the plugin's 10 s
    // deadline, so this hold is too.
    lease.release();
  }
  if (dialed instanceof Response) {
    releaseAttachment(source, prepared);
    return dialed;
  }

  // Past this point the relay owns the reservation: `teardown` is the only release.
  const relay = createRelay(source, {
    callId: prepared.callId,
    providerId: dialed.providerId,
    model: prepared.model,
    attachment: prepared.attachment,
    style,
    upstream: dialed.socket,
  });
  try {
    // The direct `(context, events)` overload of `upgradeWebSocket`, which returns
    // the 101 Response and throws when `server.upgrade` refuses. The middleware
    // overload would instead fall through to `next()` and answer 404.
    return await upgradeNativeWebSocket(context, relay.events);
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

type Dialed = { readonly providerId: string; readonly socket: WebSocket };

/** `upgradeWebSocket`, but handing `server.upgrade()` the native inbound `Request`.
 *
 *  Bun 1.4.2's `server.upgrade()` accepts only the original `Request` object associated with
 *  the inbound connection: measured, a `new Request(strippedUrl, request)` copy of it makes
 *  `upgrade()` return `false`, which Hono's direct overload turns into a throw. The auth
 *  middleware makes exactly that copy whenever the caller presented its proxy credential as
 *  `?key=`/`?auth_token=`, so without this every keyed sideband attach using a supported query
 *  credential answered 503 after already dialing the upstream.
 *
 *  Swapped around the one call and restored in a `finally` rather than reassigned, so every
 *  other reader — including the route's own `context.req.raw.signal` and `context.req.query` —
 *  keeps seeing the sanitized request. Hono derives `ws.data.url` from whatever it is handed, so
 *  during the upgrade that URL carries the query as sent; nothing reads it, and on a keyless
 *  proxy the middleware never rewrote the request at all, so this is the state that path has
 *  always been in. What the constraint is about — the upstream request and every log line — is
 *  built from the sanitized request, which this does not change. */
async function upgradeNativeWebSocket(context: Context<CallerPrincipalEnv>, events: WSEvents): Promise<Response> {
  const sanitized = context.req.raw;
  const native = nativeUpgradeRequest(sanitized);
  if (native === sanitized) return await upgradeWebSocket(context, events);
  context.req.raw = native;
  try {
    return await upgradeWebSocket(context, events);
  } finally {
    context.req.raw = sanitized;
  }
}

/** Attempts the prepared candidates in order and returns the first socket that is open, or
 *  the LAST attempt's failure once they are exhausted. A single-candidate direct dial answered
 *  502/503 while another eligible provider was healthy, which is not the failover the
 *  configured provider priority and provider weight promise. An abort is not a candidate
 *  failure and stops the loop at once. */
async function dialCandidates(
  context: Context<CallerPrincipalEnv>,
  prepared: Prepared,
  style: RealtimeStyle,
): Promise<Dialed | Response> {
  const signal = context.req.raw.signal;
  // Never observed: `prepare` answers 503 for an empty candidate list, so the loop always
  // assigns this at least once before it can be returned.
  let failure: Response = realtimeUpstreamUnavailable();
  for (const attempt of prepared.attempts) {
    if (signal.aborted) return new Response(null, { status: 499 });
    let socket: WebSocket;
    try {
      socket = await attempt.realtime.dial({
        style,
        ...(prepared.callId === undefined ? {} : { callId: prepared.callId }),
        model: prepared.model,
        // `RealtimeDialInput` promises the plugin that caller credentials are already gone,
        // and a plugin that forwards headers selectively relies on it. The auth middleware
        // only delivers that on its keyed branch: with no configured key,
        // `authenticateStaticOrAnonymous` admits the request without stripping, so the
        // caller's own `Authorization` would reach the plugin here. Stripped at the boundary
        // that makes the promise, so it holds on both branches. Built per attempt so one
        // plugin cannot hand the next a mutated `Headers`.
        headers: withoutCallerCredentials(context.req.raw.headers),
        signal,
      });
    } catch (error) {
      const kind = error instanceof RealtimeDialError ? error.kind : 'rejected';
      // The caller hung up: no other provider can serve a request that is gone.
      if (kind === 'aborted') return new Response(null, { status: 499 });
      failure = kind === 'rejected' ? realtimeDialFailed() : realtimeUpstreamUnavailable();
      continue;
    }

    if (signal.aborted) {
      // The downstream went away during the dial; close what just opened.
      closeQuietly(socket, SHUTDOWN_CLOSE_CODE);
      return new Response(null, { status: 499 });
    }

    // The dial resolves from the upstream's `open`, so an upstream that accepts the
    // handshake and drops the socket at once resolves it too — and its `close` is
    // dispatched before `createRelay` can bind a listener for it, leaving nothing to run
    // `teardown`. Checked here rather than inside the relay because this is the last point
    // at which the failure can still be a response: after the upgrade the caller would get
    // a 101 followed by an opaque close, and `teardown` would gain a second pre-open
    // trigger. Nothing can be dispatched between this check and the binding — the caller
    // runs both in the same synchronous block — so together they cover the whole window.
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      // The plugin maps every non-`1006` dial close to `rejected`; an upstream that hangs
      // up on its own socket is the same refusal, just observed one step later, so it falls
      // through to the next candidate exactly as a rejected dial does.
      failure = realtimeDialFailed();
      continue;
    }
    return { providerId: attempt.providerId, socket };
  }
  return failure;
}

function releaseAttachment(source: RealtimeRouteSource, prepared: Prepared): void {
  if (prepared.attachment !== undefined) source.realtimeCalls.release(prepared.attachment.token);
}

type RealtimeAttempt = { readonly providerId: string; readonly realtime: RealtimeTransport };

type Prepared = {
  readonly callId: string | undefined;
  readonly model: string;
  /** Ordered by provider priority then provider weight, already capped at
   *  `MAX_DIAL_ATTEMPTS`. A pinned attach contributes exactly one. */
  readonly attempts: readonly RealtimeAttempt[];
  readonly attachment: RealtimeAttachment | undefined;
};

/** All non-mutating validation runs before the reservation, so a rejected request
 *  never leaves a reservation behind. Reads the caller's snapshot rather than acquiring its
 *  own lease: the caller holds one across the dial that follows. */
function prepare(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  style: RealtimeStyle,
  snapshot: ProviderRouteSnapshot,
): Prepared | Response {
  if (style === 'realtime-direct') return prepareDirect(context, snapshot);

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

  // An attach is pinned to the account that created the call, so there is deliberately
  // nothing to fail over into: another provider does not know this `call_id`.
  const candidate = pinnedRealtimeCandidate(snapshot, {
    providerId: record.providerId,
    accountId: record.accountId,
    runtimeRevision: record.runtimeRevision,
  });
  if (candidate === undefined) return codexAuthUnavailable();

  // Reserve last: a synchronous check-and-set in one Bun isolate needs no mutex.
  const attachment = source.realtimeCalls.reserve(callId);
  if (attachment === undefined) return realtimeCallBusy();
  return {
    callId,
    model: record.model,
    attempts: [{ providerId: record.providerId, realtime: candidate.realtime }],
    attachment,
  };
}

/** A direct connection has no call record, so nothing is reserved and nothing is
 *  pinned: selection is the ordinary candidate order, and every candidate in it is
 *  interchangeable, so a failed dial falls through to the next one. */
function prepareDirect(context: Context<CallerPrincipalEnv>, snapshot: ProviderRouteSnapshot): Prepared | Response {
  const requested = context.req.query('model');
  // Bounded for the same reason as the create body's `model`: this string is sent
  // upstream and recorded in both sideband log entries, and only the parse boundary
  // sees it before it fans out.
  if (requested !== undefined && requested.length > MAX_REALTIME_MODEL_LENGTH) return realtimeInvalidModel();
  // What this socket will actually send upstream: `realtime-direct` carries the
  // ORIGINALLY REQUESTED model, defaulting to `gpt-realtime`, because substituting the
  // Codex model would diverge from Codex. Resolved before selection so the exclusion
  // check, the selection key, and the dial all reason about one string — with `?model=`
  // present but empty, deriving them separately made router policy for `gpt-realtime`
  // miss a socket that then sent `gpt-realtime`.
  const wire = requested === undefined || requested.length === 0 ? DIRECT_DEFAULT_MODEL : requested;
  // Normalization is the selection key on this path too, exactly as in the create:
  // every alias Codex uses still maps to `gpt-live-1-codex`, while an id normalization
  // passes through selects the provider that advertises *that* id. Hard-coding the
  // Codex model here sent a caller-chosen `custom-live-model` to whichever provider
  // serves Codex and skipped the one advertising it.
  const candidates = selectRealtimeCandidates(snapshot, {
    requested: wire,
    normalized: normalizeRealtimeModel(wire),
  }).slice(0, MAX_DIAL_ATTEMPTS);
  if (candidates.length === 0) return realtimeUpstreamUnavailable();
  return {
    callId: undefined,
    model: wire,
    attempts: candidates.map(({ provider, realtime }) => ({ providerId: provider.id, realtime })),
    attachment: undefined,
  };
}
