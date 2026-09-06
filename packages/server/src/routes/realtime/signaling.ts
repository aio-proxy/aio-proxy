import type { RealtimeStyle } from '@aio-proxy/plugin-sdk';
import type { Context } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { isInboundAbort } from '../../route-observation';
import { logServerEvent } from '../../server-log';
import { withoutCallerCredentialQuery } from '../../server/api-key-auth';
import { readRealtimeCreateBody, withUpstreamModel } from './create-body';
import {
  isValidCallId,
  realtimeUpstreamRejected,
  realtimeUpstreamUnavailable,
  REALTIME_CALL_ID_PATTERN,
} from './errors';
import { normalizeRealtimeModel } from './model';
import { type RealtimeCandidate, selectRealtimeCandidates } from './provider-select';
import type { RealtimeRouteSource } from './source';
import { allowlistedUpstreamHeaders, cancelUpstreamBody } from './upstream-response';

export const MAX_CREATE_ATTEMPTS = 2;

export async function handleRealtimeCreate(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  style: RealtimeStyle,
): Promise<Response> {
  const parsed = await readRealtimeCreateBody(context.req.raw);
  if (parsed instanceof Response) return parsed;

  const normalized = normalizeRealtimeModel(parsed.requestedModel);
  const upstreamBody = withUpstreamModel(parsed, normalized);
  const models = { requested: parsed.requestedModel, normalized };
  const lease = source.acquireProviderSnapshot();
  // Claimed rather than merely checked: the create yields on the upstream fetch before
  // `insert`, so a plain predicate would let concurrent creates all pass the same free
  // slot and overshoot the advertised bound. Held for the whole attempt loop and dropped
  // in the `finally` below, which every exit — 4xx, abort, throw, success — runs.
  const slot = source.realtimeCalls.reserveCapacity();
  try {
    const candidates = selectRealtimeCandidates(lease.snapshot, models).slice(0, MAX_CREATE_ATTEMPTS);
    // Capacity is claimed before the first attempt: a 503 after a successful
    // upstream create would leave an allocated call the proxy cannot route.
    if (candidates.length === 0 || slot === undefined) {
      return failed(source, { model: normalized, style, attemptCount: 0 }, realtimeUpstreamUnavailable());
    }
    return await attemptCandidates(context, source, { candidates, models, style, body: upstreamBody });
  } finally {
    slot?.release();
    lease.release();
  }
}

type AttemptInput = {
  readonly candidates: readonly RealtimeCandidate[];
  readonly models: { readonly requested: string; readonly normalized: string };
  readonly style: RealtimeStyle;
  readonly body: { readonly body: Uint8Array<ArrayBuffer>; readonly contentType: string };
};

async function attemptCandidates(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  input: AttemptInput,
): Promise<Response> {
  const signal = context.req.raw.signal;
  let attemptCount = 0;
  for (const candidate of input.candidates) {
    if (signal.aborted) break;
    attemptCount += 1;
    let response: Response;
    try {
      // A fetch body is single-use, so each attempt gets a fresh Request built
      // from the buffered bytes. No inbound Host, Content-Length, Connection, or
      // Accept-Encoding, and no caller credential in either channel: the auth
      // middleware deletes the credential headers on its keyed branch, and
      // `withoutCallerCredentialQuery` removes `?key=`/`?auth_token=` here because on a
      // keyless proxy the middleware never rewrites the URL — the plugin merges inbound
      // query onto its own upstream endpoint. The plugin adds its own upstream auth.
      response = await candidate.realtime.fetch(
        new Request(withoutCallerCredentialQuery(context.req.raw.url), {
          method: 'POST',
          body: input.body.body,
          headers: { 'content-type': input.body.contentType, accept: '*/*' },
          signal,
        }),
      );
    } catch (error) {
      if (isInboundAbort(error, signal)) return new Response(null, { status: 499 });
      // Transport failure: try the next candidate.
      continue;
    }

    if (response.ok) {
      const callId = callIdFromLocation(response.headers.get('location') ?? undefined);
      let body: ArrayBuffer;
      try {
        // Read inside the loop's own `try`: a 2xx whose stream then resets rejects here,
        // and no answer byte has reached the caller yet, so this is a failed attempt like
        // any other rather than an exception escaping as a 500.
        body = await response.arrayBuffer();
      } catch (error) {
        if (isInboundAbort(error, signal)) return new Response(null, { status: 499 });
        continue;
      }
      if (callId !== undefined && body.byteLength > 0) {
        return commit(context, source, { ...input, callId, candidate, attemptCount, response, answer: body });
      }
      continue;
    }

    // A 4xx means this offer or credential was rejected, and replaying a bad SDP onto
    // every other provider multiplies the damage. 401/429 are per-credential. A 3xx is not
    // a rejection of anything: its only actionable content lived in the `Location` that may
    // not be forwarded, so it is an availability failure of this attempt and falls through
    // to the next candidate exactly as a 5xx does.
    if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429) {
      await cancelUpstreamBody(response);
      const filtered = realtimeUpstreamRejected(response.status);
      logFailure(
        source,
        { model: input.models.normalized, style: input.style, attemptCount },
        filtered.status,
        'upstream_rejected',
        candidate.provider.id,
      );
      return filtered;
    }
    await cancelUpstreamBody(response);
  }
  return failed(
    source,
    { model: input.models.normalized, style: input.style, attemptCount },
    realtimeUpstreamUnavailable(),
  );
}

function commit(
  context: Context<CallerPrincipalEnv>,
  source: RealtimeRouteSource,
  input: AttemptInput & {
    readonly callId: string;
    readonly candidate: RealtimeCandidate;
    readonly attemptCount: number;
    readonly response: Response;
    /** Named apart from `AttemptInput.body` (the buffered *offer*) so the two
     *  cannot intersect into an uninhabited type. */
    readonly answer: ArrayBuffer;
  },
): Response {
  source.realtimeCalls.insert({
    callId: input.callId,
    providerId: input.candidate.provider.id,
    accountId: input.candidate.provider.accountId ?? '',
    runtimeRevision: input.candidate.provider.runtimeRevision ?? 0,
    model: input.models.normalized,
    requestedModel: input.models.requested,
    style: input.style,
    owner: callerPrincipal(context),
    createdAt: Date.now(),
  });
  logServerEvent(source.logger, {
    event: 'realtime.call_created',
    callId: input.callId,
    providerId: input.candidate.provider.id,
    model: input.models.normalized,
    style: input.style,
    attemptCount: input.attemptCount,
  });

  // One allowlist governs the success and the failure path, so a header an upstream adds
  // later cannot reach the caller through whichever of the two was not revisited.
  const headers = allowlistedUpstreamHeaders(input.response);
  // The upstream host is never advertised to the caller, and it is never a future
  // connection target: sideband and hangup URLs come from the plugin.
  headers.set('location', rewriteLocation(input.callId, input.style));
  return new Response(input.answer, { status: input.response.status, headers });
}

function failed(
  source: RealtimeRouteSource,
  meta: { readonly model: string; readonly style: RealtimeStyle; readonly attemptCount: number },
  response: Response,
): Response {
  logFailure(source, meta, response.status, 'realtime_upstream_unavailable', undefined);
  return response;
}

function logFailure(
  source: RealtimeRouteSource,
  meta: { readonly model: string; readonly style: RealtimeStyle; readonly attemptCount: number },
  statusCode: number,
  errorCode: string,
  providerId: string | undefined,
): void {
  // `logServerEvent` is deliberately handed an inline literal with no object
  // spread: that is the only call shape TypeScript's excess-property check
  // rejects, and it is what keeps an SDP body or a credential out of the log.
  if (providerId === undefined) {
    logServerEvent(source.logger, {
      event: 'realtime.call_failed',
      model: meta.model,
      style: meta.style,
      attemptCount: meta.attemptCount,
      statusCode,
      errorCode,
    });
    return;
  }
  logServerEvent(source.logger, {
    event: 'realtime.call_failed',
    providerId,
    model: meta.model,
    style: meta.style,
    attemptCount: meta.attemptCount,
    statusCode,
    errorCode,
  });
}

/** Parsed as a URL or a relative reference, including the query-parameter form.
 *  The host is deliberately discarded. */
export function callIdFromLocation(location: string | undefined): string | undefined {
  if (location === undefined || location.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(location, 'http://proxy.invalid');
  } catch {
    return undefined;
  }
  const fromQuery = url.searchParams.get('call_id');
  if (fromQuery !== null) return isValidCallId(fromQuery) ? fromQuery : undefined;
  // Empty segments are kept rather than filtered out: a trailing slash means the
  // upstream advertised no call id at all, and filtering would promote the
  // preceding path segment (`/v1/realtime/calls/` -> `calls`) into one.
  const last = url.pathname.split('/').at(-1);
  const decoded = last === undefined ? undefined : safeDecode(last);
  return decoded !== undefined && REALTIME_CALL_ID_PATTERN.test(decoded) ? decoded : undefined;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function rewriteLocation(callId: string, style: RealtimeStyle): string {
  // `realtime-query` advertises the /calls/ GET route deliberately: no GET route
  // exists at /v1/realtime/<callId>.
  return style === 'live' ? `/v1/live/${callId}` : `/v1/realtime/calls/${callId}`;
}
