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
  const credential = await currentCredential(credentials, options.fetch);
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

/** Caller credentials are already stripped by the auth middleware; this deletes
 *  them again so a direct unit call cannot leak one, then adds Codex auth. */
function realtimeHeaders(inbound: Headers, credential: ChatGPTCredential): Headers {
  const headers = new Headers();
  const contentType = inbound.get('content-type');
  const accept = inbound.get('accept');
  if (contentType !== null) headers.set('content-type', contentType);
  if (accept !== null) headers.set('accept', accept);
  headers.set('authorization', `Bearer ${credential.accessToken}`);
  headers.set('ChatGPT-Account-Id', credential.accountId);
  headers.set('Originator', 'codex-tui');
  headers.set('User-Agent', CHATGPT_USER_AGENT);
  headers.set('session-id', crypto.randomUUID());
  return headers;
}

function sidebandUrl(input: RealtimeDialInput): string {
  const style: RealtimeStyle = input.style;
  if (style === 'live') return `${OPENAI_REALTIME_WS_BASE}/live/${input.callId ?? ''}`;
  if (style === 'realtime-calls') return `${OPENAI_REALTIME_WS_BASE}/realtime/calls/${input.callId ?? ''}`;
  if (style === 'realtime-query') {
    return `${OPENAI_REALTIME_WS_BASE}/realtime?intent=quicksilver&call_id=${encodeURIComponent(input.callId ?? '')}`;
  }
  // `realtime-direct` sends the originally requested model, not the normalized
  // one: substituting `gpt-live-1-codex` here would diverge from the reference.
  return `${OPENAI_REALTIME_WS_BASE}/realtime?model=${encodeURIComponent(input.model ?? 'gpt-realtime')}`;
}

async function realtimeDial(
  input: RealtimeDialInput,
  credentials: CredentialPort<ChatGPTCredential>,
  options: RealtimeTransportOptions,
): Promise<WebSocket> {
  if (input.signal.aborted) throw new RealtimeDialError('dial aborted before connecting', { kind: 'aborted' });
  const credential = await currentCredential(credentials, options.fetch);
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
    socket = create(sidebandUrl(input), init);
  } catch (cause) {
    // Bun's `WebSocket` constructor throws synchronously — `SyntaxError: Invalid
    // proxy URL` for a schemeless configured proxy. `dial` promises only
    // `RealtimeDialError`, so that escape has to be converted here.
    throw new RealtimeDialError(`sideband socket could not be created: ${String(cause)}`, { kind: 'unreachable' });
  }

  return await new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
    const timer = setTimeout(
      () => abandon(new RealtimeDialError('dial deadline exceeded', { kind: 'timeout' })),
      DIAL_DEADLINE_MS,
    );

    socket.addEventListener('open', onOpen);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    input.signal.addEventListener('abort', onAbort, { once: true });
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
