import { realtimeUpstreamRejected, realtimeUpstreamUnavailable } from './errors';

/** An allowlist, not a denylist of the three headers the ruling names: the caller needs
 *  exactly enough to read the body, and anything an upstream adds later — a second
 *  cookie spelling, a tracing header naming an internal host — is dropped without this
 *  list being revisited. `retry-after` is deliberately absent: no row of the design
 *  spec's error table uses it. */
const FORWARDED_UPSTREAM_HEADERS = ['content-type'] as const;

/** Builds the caller-facing headers from scratch, so `Location`, `Set-Cookie`,
 *  `set-cookie2`, and every other upstream header are absent by construction rather
 *  than by deletion. The create's 2xx path adds its own rewritten `Location` on top.
 *
 *  The create's 2xx answer is the only response whose upstream *body* reaches the caller,
 *  because the SDP answer is the whole point of that reply. Every other path — including a
 *  successful hangup, whose caller already knows the `call_id` it tore down — discards the
 *  upstream body, so no SDP fragment or credential the upstream echoed can be relayed. */
export function allowlistedUpstreamHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_UPSTREAM_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** Releases an upstream response body whose bytes are never read, best-effort.
 *
 *  `cancel()` can reject: a plugin's `realtime.fetch` may return a `Response` over a
 *  hand-built `ReadableStream` whose `cancel` algorithm throws, and a body already errored by a
 *  transport reset rejects too. Awaiting that bare let the rejection escape the create's
 *  candidate loop and the hangup's handler as an unshaped 500 — for the create, in place of
 *  trying the next provider; for the hangup, after the record was already removed. Releasing a
 *  body is cleanup, never the outcome, so nothing here can decide either.
 *
 *  The sibling of `create-body.ts`'s `cancelRequestBody`, one direction over. */
export async function cancelUpstreamBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

/** The upstream's own body is discarded rather than relayed: one was observed echoing the
 *  caller's SDP offer back inside an error string. The accepted cost is the loss of the
 *  upstream's diagnostic detail (2026-09-06 ruling).
 *
 *  A `4xx` keeps its status, the only part of the upstream reply a client can act on. A
 *  `3xx` cannot: its target lived in the `Location` that may not be forwarded, so a
 *  redirect the proxy will not follow is an availability failure, the same as a `5xx`. */
export function realtimeFailureFromUpstream(status: number): Response {
  return status >= 400 && status < 500 ? realtimeUpstreamRejected(status) : realtimeUpstreamUnavailable();
}
