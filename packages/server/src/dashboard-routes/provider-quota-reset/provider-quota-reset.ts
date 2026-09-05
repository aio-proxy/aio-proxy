import { Hono } from 'hono';

import {
  OAuthQuotaCapabilityUnavailableError,
  OAuthQuotaResetError,
  OAuthQuotaResetInventoryUnknownError,
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
      // The preflight could not read the inventory at all, so nothing is known about the credit. 502
      // rather than 409: the cached count is unverified, not known-wrong, and the cache is deliberately
      // left alone so the button survives for a retry instead of being replaced by a reading whose
      // inventory the same failing endpoint would omit.
      if (error instanceof OAuthQuotaResetInventoryUnknownError) {
        return context.json({ error: error.code }, 502);
      }
      // The inventory the client rendered its button from is already spent or gone. 409 rather than
      // 502 so the dashboard can say so instead of reporting an upstream failure. The reset preflight
      // read upstream to learn that, which contradicts the cached snapshot the button came from: drop
      // it before answering, or the refetch after this 409 serves the same stale count for the rest of
      // the cooldown and offers the button again.
      if (error instanceof OAuthQuotaResetUnavailableError) {
        state.quotaCache.invalidate(id);
        return context.json({ error: error.code }, 409);
      }
      // The redemption reached upstream and failed there, so whether the credit was spent is unknown
      // and the cached reading can no longer be trusted either.
      if (error instanceof OAuthQuotaResetError) {
        state.quotaCache.invalidate(id);
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
