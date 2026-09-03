import { Hono } from 'hono';

import { OAuthCredentialRefreshError } from '../../credential-refresh';
import { OAuthAccountUnavailableError } from '../../oauth-account-context';
import type { ServerState } from '../../server-state';

export const createDashboardProviderCredentialRefreshRoute = (state: ServerState) =>
  new Hono().post('/providers/:id/credential/refresh', async (context) => {
    const id = context.req.param('id');
    try {
      await state.oauthCredentialRefresh.refresh(id, context.req.raw.signal);
    } catch (error) {
      // An unknown Provider, a non-OAuth Provider, and a plugin without the capability are permanent:
      // the dashboard should stop offering the action rather than retry. Every other preparation
      // failure is transient and wears the same opaque error on purpose, so the body never says which.
      if (error instanceof OAuthAccountUnavailableError) {
        return context.json({ error: error.code }, error.permanent ? 404 : 502);
      }
      if (error instanceof OAuthCredentialRefreshError) {
        return context.json({ error: error.code }, 502);
      }
      throw error;
    }
    // No summary in the body: the rebuild `onDiagnosticChanged` queues has not landed yet, so any
    // summary read here would still carry the pre-refresh `accountLabel` and `expiresAt`. The client
    // invalidates the Provider list and refetches instead of seeding it from this response.
    return context.json({ ok: true });
  });
