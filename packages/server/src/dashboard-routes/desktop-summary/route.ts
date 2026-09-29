import { timingSafeEqual } from 'node:crypto';

import { Hono, type MiddlewareHandler } from 'hono';

import { dashboardSessionToken, isDashboardLoopbackRequest } from '../../dashboard-auth';
import type { ServerState } from '../../server-state';
import { buildDesktopSummary } from './desktop-summary';

const sameToken = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The desktop token's only door. It is checked here rather than in `DashboardAuthentication.verify`
 * so the token never becomes a dashboard session, and it is accepted only from a loopback socket peer.
 */
export const requireDesktopToken =
  (expected: () => string | undefined): MiddlewareHandler =>
  async (context, next) => {
    const token = expected();
    const presented = dashboardSessionToken(context);
    if (
      token === undefined ||
      presented === undefined ||
      !isDashboardLoopbackRequest(context) ||
      !sameToken(presented, token)
    ) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    await next();
  };

export const createDesktopSummaryRoute = (state: ServerState, version: string) =>
  new Hono().get(
    '/',
    requireDesktopToken(() => state.desktopToken),
    async (context) =>
      context.json(
        await buildDesktopSummary(state, {
          version,
          pid: process.pid,
          ppid: process.ppid,
          now: new Date(),
          refresh: context.req.query('refresh') === 'true',
        }),
      ),
  );
