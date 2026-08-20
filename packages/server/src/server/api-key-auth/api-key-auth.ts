import { timingSafeEqual } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';

type ApiKeyEntry = { readonly key: string };

export const requireApiKey =
  (apiKeys: () => readonly ApiKeyEntry[]): MiddlewareHandler =>
  async (context, next) =>
    authenticateStaticOrAnonymous(context, next, apiKeys());

export async function authenticateStaticOrAnonymous(
  context: Context,
  next: () => Promise<void>,
  configuredKeys: readonly ApiKeyEntry[],
): Promise<Response | void> {
  if (configuredKeys.length === 0) {
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
  if (!candidates.some((candidate) => candidate !== undefined && matchesConfiguredKey(candidate, configuredKeys))) {
    return authenticationError(context);
  }

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

function matchesConfiguredKey(candidate: string, configuredKeys: readonly ApiKeyEntry[]): boolean {
  const candidateBytes = Buffer.from(candidate);
  return configuredKeys.some(({ key }) => {
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
