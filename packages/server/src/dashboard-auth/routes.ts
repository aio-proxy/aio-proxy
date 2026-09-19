import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';

import type { DashboardAuthentication } from './dashboard-auth';

const passwordBodyValidator = validator('json', (value, context): { readonly password: string } | Response =>
  isPasswordBody(value) ? value : context.json({ error: 'invalid_request' }, 400),
);

const sessionStatus = (auth: DashboardAuthentication, context: Context) => {
  if (!auth.available()) return 'unavailable' as const;
  if (!auth.enabled()) return 'disabled' as const;
  return auth.verify(dashboardSessionToken(context)) ? ('authenticated' as const) : ('unauthenticated' as const);
};

export const createDashboardAuthRoutes = (auth: DashboardAuthentication) =>
  new Hono()
    .get('/session', (context) =>
      context.json({
        status: sessionStatus(auth, context),
      }),
    )
    .post('/login', passwordBodyValidator, async (context) => {
      const body = context.req.valid('json');
      const result = await auth.login(body.password, clientId(context));
      if (result.status === 'unavailable') return context.json({ error: 'dashboard_unavailable' }, 503);
      if (result.status === 'disabled') return context.json({ error: 'authentication_disabled' }, 409);
      if (result.status === 'invalid') return context.json({ error: 'invalid_password' }, 401);
      if (result.status === 'rate-limited') {
        context.header('retry-after', String(result.retryAfterSeconds));
        return context.json({ error: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds }, 429);
      }
      if (result.status !== 'authenticated') return context.json({ error: 'authentication_failed' }, 500);
      return context.json({ ok: true, token: result.token, expiresAt: new Date(result.expiresAt).toISOString() });
    })
    .post('/logout', (context) => context.json({ ok: true }));

export const requireDashboardAuthentication =
  (auth: DashboardAuthentication): MiddlewareHandler =>
  async (context, next) => {
    if (!auth.available()) return context.json({ error: 'dashboard_unavailable' }, 503);
    if (!auth.enabled() || auth.verify(dashboardSessionToken(context))) {
      await next();
      return;
    }
    return context.json({ error: 'authentication_required' }, 401);
  };

/**
 * The single definition of the authentication subtree, shared by the renewal guard below and the
 * authentication exemption in `createRoutes`. The two must cover the same paths: one exempt from
 * authentication but not from renewal would attach a renewed session to a refused login.
 */
export const isDashboardAuthRoutePath = (path: string): boolean => path.startsWith('/dashboard/api/auth/');

// Renewals are confined to callers holding a currently valid session by `refresh` itself, which
// re-verifies the token against the password hash read at call time; this middleware reads only the
// inbound `authorization` header, so it consumes nothing the authentication middleware sets. The
// registration position — ahead of that middleware — buys only Hono's onion ordering: registering
// first runs this body last, on the way out.
export const attachDashboardSessionRefresh =
  (auth: DashboardAuthentication): MiddlewareHandler =>
  async (context, next) => {
    await next();
    // Authentication routes never hand out renewed sessions: a refused password must not extend the
    // session the caller already holds, and logout must not return a live one. `/auth/session`
    // forgoes renewal with them; every other `/dashboard/api/*` request still renews.
    if (isDashboardAuthRoutePath(context.req.path)) return;
    const token = dashboardSessionToken(context);
    if (token === undefined) return;
    const renewed = auth.refresh(token);
    if (renewed !== undefined) context.header('x-dashboard-session-refresh', renewed);
  };

export const requireDashboardLoopback: MiddlewareHandler = async (context, next) => {
  if (!isDashboardLoopbackRequest(context)) return context.notFound();
  await next();
};

export function isDashboardLoopbackRequest(context: Context): boolean {
  const address = requestAddress(context);
  return address !== undefined && isLoopbackAddress(address);
}

export function dashboardSessionToken(context: Context): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(context.req.header('authorization') ?? '');
  return match?.[1];
}

function isPasswordBody(value: unknown): value is { readonly password: string } {
  return typeof value === 'object' && value !== null && 'password' in value && typeof value.password === 'string';
}

function clientId(context: Context): string {
  return requestAddress(context) ?? 'loopback';
}

function requestAddress(context: Context): string | undefined {
  const server = context.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  return server?.requestIP?.(context.req.raw)?.address;
}

function isLoopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}
