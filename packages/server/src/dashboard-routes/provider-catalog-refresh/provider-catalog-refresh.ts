import { Hono } from 'hono';

import type { ServerState } from '../../server-state';

export const createDashboardProviderCatalogRefreshRoute = (state: ServerState) =>
  new Hono().post('/providers/:id/catalog/refresh', async (context) => {
    const id = context.req.param('id');
    const provider = state.currentConfig().providers.find((candidate) => candidate.id === id);
    // Only OAuth Providers discover their catalog. An unknown or non-OAuth Provider is permanent: the
    // dashboard should stop offering the action rather than retry.
    if (provider === undefined || provider.kind !== 'oauth') {
      return context.json({ error: 'provider not found' }, 404);
    }
    const outcome = await state.refreshProviderCatalog(id);
    // `'unknown'` means the Provider exists in config but currently has no catalog job, i.e. account
    // preparation failed (broken credential, missing plugin, invalid account options). That is a
    // retryable runtime state, not a permanent 404, so it answers the same as a failed discovery.
    if (outcome !== 'refreshed') return context.json({ error: 'CATALOG_UNAVAILABLE' }, 502);
    // No catalog in the body: the refresh already awaited the snapshot rebuild, so the client's own
    // edit-view refetch reads the new model list.
    return context.json({ ok: true });
  });
