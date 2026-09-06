import { timingSafeEqual } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';

import { ANONYMOUS_CALLER, type CallerPrincipalEnv, staticKeyCallerPrincipal } from '../../caller-principal';

type ApiKeyEntry = { readonly key: string };

export const requireApiKey =
  (apiKeys: () => readonly ApiKeyEntry[]): MiddlewareHandler =>
  async (context, next) =>
    authenticateStaticOrAnonymous(context, next, apiKeys());

export async function authenticateStaticOrAnonymous(
  context: Context<CallerPrincipalEnv>,
  next: () => Promise<void>,
  configuredKeys: readonly ApiKeyEntry[],
): Promise<Response | void> {
  if (configuredKeys.length === 0) {
    // Stamped rather than left to `callerPrincipal()`'s fallback so an absent context
    // variable means only that no auth middleware ran: Hono's `app.use` covers just the
    // routes registered after it, and a route registered ahead of it would otherwise read
    // as this same anonymous principal on a key-protected proxy.
    context.set('callerPrincipal', ANONYMOUS_CALLER);
    await next();
    return;
  }

  const candidates = [
    bearerToken(context.req.header('authorization')),
    context.req.header('x-api-key'),
    context.req.header('x-goog-api-key'),
    context.req.query('key'),
    context.req.query('auth_token'),
  ];
  let matched: ApiKeyEntry | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const entry = matchedConfiguredKey(candidate, configuredKeys);
    // Written only on a real match: an outer variable assigned before the check would
    // survive the loop as a stale entry and derive the principal from a key that never
    // matched, while the request is still admitted.
    if (entry !== undefined) {
      matched = entry;
      break;
    }
  }
  if (matched === undefined) return authenticationError(context);

  context.set('callerPrincipal', staticKeyCallerPrincipal(matched.key));
  stripCallerCredentials(context);
  await next();
}

export function stripCallerCredentials(context: Context): void {
  for (const header of CALLER_CREDENTIAL_HEADERS) context.req.raw.headers.delete(header);
  context.req.raw = withoutCallerQuery(context.req.raw);
}

/** The headers a caller may present a proxy credential in. */
const CALLER_CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key'] as const;

/** The query parameters a caller may present a proxy credential in — the same two the
 *  candidate list above reads, so a name added there is added here. */
const CALLER_CREDENTIAL_QUERY_PARAMS = ['key', 'auth_token'] as const;

/** A copy of `headers` with every caller credential removed, for the one path that hands
 *  inbound headers to a plugin. `stripCallerCredentials` cannot stand in for it: it only
 *  runs on the keyed branch of `authenticateStaticOrAnonymous`, so on a keyless proxy the
 *  caller's own `Authorization` is still on the request when the route reads it. Copied
 *  rather than mutated in place so a route keeps its inbound headers for its own use. */
export function withoutCallerCredentials(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const header of CALLER_CREDENTIAL_HEADERS) copy.delete(header);
  return copy;
}

/** `url` with every caller credential query parameter removed, for the paths that build an
 *  upstream request from the inbound URL. Same asymmetry as `withoutCallerCredentials`, one
 *  channel over: `stripCallerCredentials` rewrites the request on the keyed branch only, so
 *  on a keyless proxy `?key=`/`?auth_token=` are still on the inbound URL when a route reads
 *  it — and a plugin that merges inbound query onto its own upstream endpoint would send them
 *  on. Returns a string because that is what the `Request` constructor wants at every call
 *  site, and takes one so no caller has to build a `URL` just to discard it. */
export function withoutCallerCredentialQuery(url: string): string {
  const parsed = new URL(url);
  if (!CALLER_CREDENTIAL_QUERY_PARAMS.some((param) => parsed.searchParams.has(param))) return url;
  for (const param of CALLER_CREDENTIAL_QUERY_PARAMS) parsed.searchParams.delete(param);
  return parsed.toString();
}

export function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? '');
  return match?.[1];
}

function withoutCallerQuery(request: Request): Request {
  const stripped = withoutCallerCredentialQuery(request.url);
  if (stripped === request.url) return request;
  const sanitized = new Request(stripped, request);
  nativeRequests.set(sanitized, request);
  return sanitized;
}

/** Maps each sanitized request back to the native one it was copied from. Keyed on the copy
 *  and weak so nothing outlives the request. */
const nativeRequests = new WeakMap<Request, Request>();

/** The native inbound `Request` `request` was copied from, or `request` itself when it is
 *  already native.
 *
 *  Only `server.upgrade()` needs this. Measured on Bun 1.4.2: `upgrade()` accepts solely the
 *  original `Request` object associated with the inbound connection and returns `false` for a
 *  `new Request(...)` copy of it — which Hono's direct `upgradeWebSocket` overload turns into a
 *  throw. So a WebSocket route reached through `stripCallerCredentials`, which replaces
 *  `context.req.raw` with a copy whenever the caller presented `?key=`/`?auth_token=`, cannot
 *  upgrade at all unless it hands `upgrade()` the original object back. Every other reader must
 *  keep seeing the sanitized copy, so the swap has to be scoped to the `upgrade()` call. */
export function nativeUpgradeRequest(request: Request): Request {
  return nativeRequests.get(request) ?? request;
}

function matchedConfiguredKey(candidate: string, configuredKeys: readonly ApiKeyEntry[]): ApiKeyEntry | undefined {
  const candidateBytes = Buffer.from(candidate);
  return configuredKeys.find(({ key }) => {
    const keyBytes = Buffer.from(key);
    return keyBytes.byteLength === candidateBytes.byteLength && timingSafeEqual(keyBytes, candidateBytes);
  });
}

export function authenticationError(context: Context): Response {
  if (context.req.path.startsWith('/v1/messages')) {
    return context.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } }, 401);
  }
  if (context.req.path.startsWith('/v1beta/')) {
    return context.json({ error: { code: 401, message: 'Invalid API key', status: 'UNAUTHENTICATED' } }, 401);
  }
  return context.json({ error: { message: 'Invalid API key', type: 'authentication_error' } }, 401);
}
