import { Hono } from 'hono';

import {
  OAuthQuotaCapabilityUnavailableError,
  OAuthQuotaResetError,
  OAuthQuotaResetUnavailableError,
  OAuthQuotaResetUnsupportedError,
} from '../../plugin-quota';
import type { ServerState } from '../../server-state';

export const createDashboardProviderQuotaResetRoute = (state: ServerState) =>
  new Hono().post('/providers/:id/quota/reset', async (context) => {
    const id = context.req.param('id');
    if (!state.currentConfig().providers.some((provider) => provider.id === id)) {
      return context.json({ error: 'provider not found' }, 404);
    }
    try {
      await state.oauthQuota.reset(id, context.req.raw.signal);
    } catch (error) {
      // A plugin with no reset is a permanent 404 the dashboard should stop offering, and so is a
      // Provider whose plugin exposes no quota capability at all. Every other preparation failure
      // wears the same opaque error but stays retryable.
      if (error instanceof OAuthQuotaResetUnsupportedError) {
        return context.json({ error: error.code }, 404);
      }
      if (error instanceof OAuthQuotaCapabilityUnavailableError) {
        return context.json({ error: error.code }, error.permanent ? 404 : 502);
      }
      // The inventory the client rendered its button from is already spent or gone. 409 rather than
      // 502 so the dashboard can say so instead of reporting an upstream failure.
      if (error instanceof OAuthQuotaResetUnavailableError) {
        return context.json({ error: error.code }, 409);
      }
      if (error instanceof OAuthQuotaResetError) {
        return context.json({ error: error.code }, 502);
      }
      throw error;
    }
    // The redemption invalidates the cached snapshot it was authorized from, so the next read goes
    // upstream instead of serving a pre-reset reading for the rest of the cooldown. Nothing is
    // returned: the client refetches the quota query, which is the one path that seeds its cache.
    state.quotaCache.invalidate(id);
    return context.json({ ok: true });
  });
