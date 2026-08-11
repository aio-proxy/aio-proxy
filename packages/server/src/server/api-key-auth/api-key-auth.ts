import { timingSafeEqual } from 'node:crypto';

import type { Context, MiddlewareHandler } from 'hono';

type ApiKeyEntry = { readonly key: string };

export const requireApiKey =
  (apiKeys: () => readonly ApiKeyEntry[]): MiddlewareHandler =>
  async (context, next) => {
    const configuredKeys = apiKeys();
    if (configuredKeys.length === 0) {
      await next();
      return;
    }

    const candidates = [
      bearerToken(context.req.header('authorization')),
      context.req.header('x-api-key'),
      ...(context.req.path.startsWith('/v1beta/') ? [context.req.header('x-goog-api-key')] : []),
    ];
    if (!candidates.some((candidate) => candidate !== undefined && matchesConfiguredKey(candidate, configuredKeys))) {
      return authenticationError(context);
    }

    context.req.raw.headers.delete('authorization');
    context.req.raw.headers.delete('x-api-key');
    context.req.raw.headers.delete('x-goog-api-key');
    await next();
  };

function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(value ?? '');
  return match?.[1];
}

function matchesConfiguredKey(candidate: string, configuredKeys: readonly ApiKeyEntry[]): boolean {
  const candidateBytes = Buffer.from(candidate);
  return configuredKeys.some(({ key }) => {
    const keyBytes = Buffer.from(key);
    return keyBytes.byteLength === candidateBytes.byteLength && timingSafeEqual(keyBytes, candidateBytes);
  });
}

function authenticationError(context: Context): Response {
  if (context.req.path.startsWith('/v1/messages')) {
    return context.json({ type: 'error', error: { type: 'authentication_error', message: 'Invalid API key' } }, 401);
  }
  if (context.req.path.startsWith('/v1beta/')) {
    return context.json({ error: { code: 401, message: 'Invalid API key', status: 'UNAUTHENTICATED' } }, 401);
  }
  return context.json({ error: { message: 'Invalid API key', type: 'authentication_error' } }, 401);
}
