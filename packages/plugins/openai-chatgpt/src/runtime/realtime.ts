import type {
  CredentialPort,
  RealtimeDialInput,
  RealtimeStyle,
  RealtimeTransport,
  RuntimeFetch,
} from '@aio-proxy/plugin-sdk';
import { RealtimeDialError } from '@aio-proxy/plugin-sdk';

import { CHATGPT_USER_AGENT } from '../codex-client';
import type { ChatGPTCredential } from '../schema';
import { currentCredential } from './runtime';

const CODEX_REALTIME_CREATE_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas' as const;
const OPENAI_REALTIME_WS_BASE = 'wss://api.openai.com/v1' as const;
const OPENAI_REALTIME_HANGUP_BASE = 'https://api.openai.com/v1/realtime/calls' as const;
const DIAL_DEADLINE_MS = 10_000;

/** The only model this transport serves. Selection normalizes to it upstream. */
export const CODEX_REALTIME_MODELS: readonly string[] = ['gpt-live-1-codex'];

const HANGUP_PATH = /^\/v1\/realtime\/calls\/([A-Za-z0-9_-]{1,128})\/hangup$/u;

/** Exact pathname matching, unlike the `endsWith` mapping the Responses and image
 *  endpoints use: `/v1/realtime` and `/v1/realtime/calls` are prefixes of other
 *  realtime paths and a suffix test would collide. Returns `undefined` for
 *  everything else so the caller can fail closed. */
export function realtimeEndpointFor(pathname: string): string | undefined {
  if (pathname === '/v1/live' || pathname === '/v1/realtime' || pathname === '/v1/realtime/calls') {
    return CODEX_REALTIME_CREATE_ENDPOINT;
  }
  const hangup = HANGUP_PATH.exec(pathname);
  if (hangup?.[1] !== undefined) return `${OPENAI_REALTIME_HANGUP_BASE}/${hangup[1]}/hangup`;
  return undefined;
}

/** The endpoint constant owns `intent` and `architecture`. Assigning
 *  `endpoint.search = inbound.search` — what `rewriteCodexUrl` did before — erases
 *  them for an inbound request with no query. Inbound parameters merge on top,
 *  overriding an endpoint-owned key while keeping repeated inbound values intact. */
export function mergeEndpointQuery(endpoint: string, inbound: URL): URL {
  const merged = new URL(endpoint);
  for (const key of new Set(inbound.searchParams.keys())) {
    merged.searchParams.delete(key);
    for (const value of inbound.searchParams.getAll(key)) merged.searchParams.append(key, value);
  }
  return merged;
}

export type RealtimeWebSocketFactory = (
  url: string,
  init: { readonly proxy?: string; readonly headers: Record<string, string> },
) => WebSocket;

export type RealtimeTransportOptions = {
  readonly fetch: RuntimeFetch;
  readonly proxy: string | null;
  /** Seam for tests. Production passes Bun's global `WebSocket`, whose `proxy`
   *  option issues a `CONNECT` — a plugin-constructed socket inherits nothing
   *  from `createProxyFetch`, so the proxy must be passed here explicitly. */
  readonly createWebSocket?: RealtimeWebSocketFactory;
  /** Seam for tests, defaulting to `OPENAI_REALTIME_WS_BASE`. A proxy assertion has
   *  to dial a local upstream, and the target the recorded `CONNECT` names is derived
   *  from this base, so it cannot stay a module constant. */
  readonly baseUrl?: string;
};

export function createOpenAIChatGPTRealtime(
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
): RealtimeTransport {
  return {
    models: CODEX_REALTIME_MODELS,
    fetch: (request) => realtimeFetch(request, credentials, options),
    dial: (input) => realtimeDial(input, credentials, options),
  };
}

async function realtimeFetch(
  request: Request,
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
): Promise<Response> {
  const inbound = new URL(request.url);
  const endpoint = realtimeEndpointFor(inbound.pathname);
  if (endpoint === undefined) throw new Error(`Unmapped realtime path: ${inbound.pathname}`);
  const url = mergeEndpointQuery(endpoint, inbound);
  const credential = await credentialForFetch(credentials, options, request.signal);
  const headers = realtimeHeaders(request.headers, credential);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  return await options.fetch(url.toString(), {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
    signal: request.signal,
    redirect: 'manual',
  });
}

/** Races the credential read against the caller's abort, the same shape `credentialForDial`
 *  uses and for the same reason: `currentCredential` is unbounded from this side —
 *  `createCredentialPort.refresh` waits up to 60 s for another process's refresh lease and its
 *  `exchange` carries a 30 s timeout on the lease's own signal, not the caller's — so an inbound
 *  abort was observed only by `options.fetch`, long after the wait.
 *
 *  That wait is not free to the proxy: `handleRealtimeCreate` releases the call-store capacity
 *  slot and the provider snapshot lease in a `finally` around the whole attempt loop, and this
 *  await is inside it, so an aborted create held one of 1024 slots and blocked provider reload
 *  for the credential port's wait rather than for its own request's lifetime.
 *
 *  Raced here rather than by threading the signal into `currentCredential`: a refresh in flight
 *  is shared work whose result other requests want, so it is left running and only this request
 *  stops waiting. Rejects with an `AbortError`, which is what `isInboundAbort` at both call
 *  sites already reads as a caller hangup — a bare `Error` would be logged as a transport
 *  failure and fall through to the next candidate for a caller that is gone. */
async function credentialForFetch(
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
  signal: AbortSignal,
): Promise<ChatGPTCredential> {
  if (signal.aborted) throw abortError();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      currentCredential(credentials, options.fetch),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    // Without this the listener outlives every request that resolved normally, and one
    // long-lived signal accumulates one leaked closure per realtime fetch.
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** The shape `fetch` itself rejects with on an aborted signal, so the routes' `isInboundAbort`
 *  cannot tell this rejection apart from the one it already handles. */
function abortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError') as unknown as Error;
}

/** Caller credentials are already stripped by the auth middleware; this deletes
 *  them again so a direct unit call cannot leak one, then adds Codex auth. */
function realtimeHeaders(inbound: Headers, credential: ChatGPTCredential): Headers {
  const headers = new Headers();
  const contentType = inbound.get('content-type');
  const accept = inbound.get('accept');
  if (contentType !== null) headers.set('content-type', contentType);
  if (accept !== null) headers.set('accept', accept);
  try {
    headers.set('authorization', `Bearer ${credential.accessToken}`);
    headers.set('ChatGPT-Account-Id', credential.accountId);
  } catch {
    // A stored credential can carry an embedded CR, LF, or NUL that `.trim()` does
    // not strip, and `Headers.set` rejects it by echoing the offending value
    // verbatim, so nothing from the cause may reach this message. `realtimeFetch`
    // surfaces its own failures as plain `Error`s; this is not a dial failure.
    throw new Error('Codex credential is not a valid header value');
  }
  headers.set('Originator', 'codex-tui');
  headers.set('User-Agent', CHATGPT_USER_AGENT);
  headers.set('session-id', crypto.randomUUID());
  return headers;
}

function sidebandUrl(input: RealtimeDialInput, base: string): string {
  const style: RealtimeStyle = input.style;
  // Encoded even though the route will validate `call_id` against
  // `^[A-Za-z0-9_-]{1,128}$`: the plugin owns these URLs and must not let a caller
  // rewrite the target path with a traversal segment.
  const callId = encodeURIComponent(input.callId ?? '');
  if (style === 'live') return `${base}/live/${callId}`;
  if (style === 'realtime-calls') return `${base}/realtime/calls/${callId}`;
  if (style === 'realtime-query') {
    return `${base}/realtime?intent=quicksilver&call_id=${callId}`;
  }
  // `realtime-direct` sends the originally requested model, not the normalized
  // one: substituting `gpt-live-1-codex` here would diverge from the reference.
  return `${base}/realtime?model=${encodeURIComponent(input.model ?? 'gpt-realtime')}`;
}

type DialDeadline = {
  /** Registers the current phase's expiry handler, replacing the previous phase's, and runs
   *  it at once when the deadline has already passed. */
  readonly onExpire: (handler: () => void) => void;
  readonly clear: () => void;
};

/** ONE timer for the whole dial, armed before the credential read rather than after it.
 *  `DIAL_DEADLINE_MS` is advertised as the bound on the dial, and the credential read is part
 *  of it: `createCredentialPort.refresh` waits up to 60 s for another process's refresh lease,
 *  so a deadline armed only around the socket left the advertised 10 s starting after a wait
 *  that could already have run to 60. A single timer whose handler is re-registered as the
 *  dial moves from the credential race to the socket wait bounds whichever phase is current
 *  and keeps the total at 10 s rather than 10 s per phase. */
function armDialDeadline(): DialDeadline {
  let expired = false;
  let handler: (() => void) | undefined;
  const timer = setTimeout(() => {
    expired = true;
    handler?.();
  }, DIAL_DEADLINE_MS);
  return {
    onExpire: (next) => {
      handler = next;
      // The deadline can fall between the credential resolving and the socket promise being
      // constructed, where the handler registered above belongs to a race that has already
      // settled and rejecting it is a no-op. Without this the dial would then wait forever.
      if (expired) next();
    },
    clear: () => clearTimeout(timer),
  };
}

/** The credential read is the only await before the socket exists, and it is unbounded from
 *  this side: `createCredentialPort.refresh` waits up to 60 s for another process's refresh
 *  lease and its `exchange` signal is the lease's, not the caller's. So neither the caller's
 *  abort nor the dial deadline would cover that window if both were armed around the socket
 *  alone; a caller that hung up mid-wait would still have a socket opened and a credential
 *  minted for it. Raced here rather than by threading the signal into `currentCredential`: a
 *  refresh in flight is shared work whose result other requests want, so it is left running
 *  and only this dial stops waiting. */
async function credentialForDial(
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
  signal: AbortSignal,
  deadline: DialDeadline,
): Promise<ChatGPTCredential> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      currentCredential(credentials, options.fetch),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new RealtimeDialError('dial aborted', { kind: 'aborted' }));
        signal.addEventListener('abort', onAbort, { once: true });
        deadline.onExpire(() => reject(new RealtimeDialError('dial deadline exceeded', { kind: 'timeout' })));
      }),
    ]);
  } catch (error) {
    // The abort rejection is already the error `dial` promises; only a credential failure
    // needs converting. A refresh failure carries provider text that may quote the
    // credential, and `RealtimeDialError` has no `cause` channel to keep it out of
    // `message`, so nothing from the cause is carried over.
    if (error instanceof RealtimeDialError) throw error;
    throw new RealtimeDialError('Codex credential unavailable for the sideband dial', { kind: 'unreachable' });
  } finally {
    // Without this the listener outlives every dial that resolved normally, and one
    // long-lived request signal accumulates one leaked closure per realtime dial.
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

async function realtimeDial(
  input: RealtimeDialInput,
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
): Promise<WebSocket> {
  if (input.signal.aborted) throw new RealtimeDialError('dial aborted before connecting', { kind: 'aborted' });
  // Armed before the credential read so the advertised bound covers the whole dial. The
  // `finally` is the only release: a dial that resolves a socket must not leave a timer that
  // would later close it.
  const deadline = armDialDeadline();
  try {
    return await dialWithDeadline(input, credentials, options, deadline);
  } finally {
    deadline.clear();
  }
}

async function dialWithDeadline(
  input: RealtimeDialInput,
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
  deadline: DialDeadline,
): Promise<WebSocket> {
  const credential = await credentialForDial(credentials, options, input.signal, deadline);
  const create = options.createWebSocket ?? defaultWebSocketFactory;
  const init = {
    ...(options.proxy === null ? {} : { proxy: options.proxy }),
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      'ChatGPT-Account-Id': credential.accountId,
      Originator: 'codex-tui',
      'User-Agent': CHATGPT_USER_AGENT,
      'session-id': crypto.randomUUID(),
    },
  };
  let socket: WebSocket;
  try {
    socket = create(sidebandUrl(input, options.baseUrl ?? OPENAI_REALTIME_WS_BASE), init);
  } catch (cause) {
    // Bun's `WebSocket` constructor throws synchronously — `SyntaxError: Invalid
    // proxy URL` for a schemeless configured proxy, `TypeError` for a header value
    // Bun rejects. That `TypeError` echoes the offending value verbatim, and `init`
    // carries the Bearer token, so only the error's name may cross this boundary.
    // `dial` promises only `RealtimeDialError`, so the escape is converted here.
    const causeName = cause instanceof Error ? cause.name : 'Error';
    throw new RealtimeDialError(`sideband socket could not be created (${causeName})`, { kind: 'unreachable' });
  }

  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      deadline.clear();
      input.signal.removeEventListener('abort', onAbort);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      outcome();
    };
    const abandon = (error: RealtimeDialError): void => {
      finish(() => {
        try {
          socket.close(1001);
        } catch {}
        reject(error);
      });
    };
    const onOpen = (): void => finish(() => resolve(socket));
    // A client `WebSocket` exposes no upstream status: `401`, `404`, `429`, `500`,
    // and `501` all arrive as `1002` "Expected 101 status code". `1006` is the
    // only distinguishable case, and it means the connect itself failed.
    const onClose = (event: Event): void => {
      const code = (event as CloseEvent).code;
      const kind = code === 1006 ? 'unreachable' : 'rejected';
      finish(() => reject(new RealtimeDialError(`sideband dial failed with close code ${code}`, { kind })));
    };
    const onError = (): void => {
      // `error` carries no status either, and Bun always follows it with `close`.
      // Waiting for `close` keeps the `rejected`/`unreachable` split intact.
    };
    const onAbort = (): void => abandon(new RealtimeDialError('dial aborted', { kind: 'aborted' }));

    socket.addEventListener('open', onOpen);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    input.signal.addEventListener('abort', onAbort, { once: true });
    // Whatever remains of the one dial deadline now bounds the socket wait; a credential read
    // that consumed nine of the ten seconds leaves one, not ten.
    deadline.onExpire(() => abandon(new RealtimeDialError('dial deadline exceeded', { kind: 'timeout' })));
    // The signal can abort while the credential await above is in flight, and
    // `addEventListener` never fires for an already-aborted signal. Re-check here
    // so a late abort still abandons the socket instead of hanging to the deadline.
    if (input.signal.aborted) onAbort();
    else if (socket.readyState === 1) onOpen();
  });
}

/** Bun's `WebSocket` accepts an options object, but `bun-types` defers the global
 *  constructor's type to `lib.dom`'s two-argument `(url, protocols)` form whenever
 *  the DOM lib is loaded. This alias restores the option-object overload without
 *  reaching for an `any`. */
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

function defaultWebSocketFactory(
  url: string,
  init: { readonly proxy?: string; readonly headers: Record<string, string> },
): WebSocket {
  return new BunWebSocket(url, init);
}
