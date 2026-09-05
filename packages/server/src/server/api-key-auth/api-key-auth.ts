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
  context.req.raw.headers.delete('authorization');
  context.req.raw.headers.delete('x-api-key');
  context.req.raw.headers.delete('x-goog-api-key');
  context.req.raw = withoutCallerQuery(context.req.raw);
}

export function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? '');
  return match?.[1];
}

function withoutCallerQuery(request: Request): Request {
  const url = new URL(request.url);
  if (!url.searchParams.has('key') && !url.searchParams.has('auth_token')) {
    return request;
  }
  url.searchParams.delete('key');
  url.searchParams.delete('auth_token');
  return new Request(url, request);
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
