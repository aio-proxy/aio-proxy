import { isPlainObject } from 'es-toolkit/predicate';
import { Hono } from 'hono';
import { validator } from 'hono/validator';

import { OAuthQuotaCapabilityUnavailableError } from '../../plugin-quota';
import type { ServerState } from '../../server-state';
import { providerPackageQueryValidator, providerPackageStatus } from '../provider-package-metadata';
import { providerRoutingRevision, providerRoutingValues } from '../provider-routing-mutation';

const probeKey = 'probe';

const providerProbeValidator = validator('query', (raw): { readonly probe?: string } =>
  typeof raw[probeKey] === 'string' ? { probe: raw[probeKey] } : {},
);

// The body is optional and the only field that matters is the manual-refresh escape hatch.
const quotaRefreshValidator = validator('json', (raw): { readonly refresh: boolean } => ({
  refresh: isPlainObject(raw) && raw['refresh'] === true,
}));

// Same shape as `probe` above: a read that opts into live upstream work on request only. Here it is
// the rediscovery the editor's reload button needs.
const editViewRefreshValidator = validator('query', (raw): { readonly refreshCatalog: boolean } => ({
  refreshCatalog: raw['refreshCatalog'] === 'true',
}));

export const createDashboardProviderReadRoutes = (state: ServerState) =>
  new Hono()
    .get('/providers', async (context) => {
      const filter = context.req.query('filter');
      const probe = context.req.query('probe') === 'true';
      // Both the revision and the summaries come from the running config, so they always describe one
      // snapshot. Reading the revision off disk instead would make it *newer* than the values shipped
      // with it while the watcher lags an external edit, and the client's next save would pass the
      // revision check and silently overwrite that edit. Pairing them means the same window costs one
      // rejected `stale_revision` instead. The save re-derives the set from the record it commits, so
      // a Provider only present on disk still surfaces as `provider_set_changed`.
      const routingRevision = providerRoutingRevision(state.currentConfig().providers.map(providerRoutingValues));
      const providers = await state.providerSummaries({ filter, probe });
      return context.json({ providers, routingRevision });
    })
    .get('/providers/package-status', providerPackageQueryValidator, async (context) =>
      context.json(await providerPackageStatus(context.req.valid('query').npm)),
    )
    .get('/providers/:id/edit-view', editViewRefreshValidator, async (context) => {
      const id = context.req.param('id');
      // Real values on purpose: the editor round-trips this entry straight back
      // through the mutation endpoint, and every masked field it had to restore
      // was a source of Bearer '****' bugs. GET /config and the CLI still mask.
      const provider = state.currentConfig().providers.find((entry) => entry.id === id);
      if (provider === undefined) {
        return context.json({ error: 'provider not found' }, 404);
      }
      // The stored catalog is all this view can read, so the editor's reload button asks for the
      // rediscovery here rather than redrawing the same rows until the plugin's TTL expires. Only on
      // request: an ordinary open, save, or invalidation must never hit upstream.
      const refreshed =
        provider.kind === 'oauth' && context.req.valid('query').refreshCatalog
          ? await state.refreshProviderCatalog(id)
          : undefined;
      const oauth = provider.kind === 'oauth' ? state.oauthProviderEditView(id) : undefined;
      const routing = await state.modelRouting.providerNumberViews(id);
      return context.json({
        provider,
        ...(oauth === undefined ? {} : { oauth }),
        ...(routing === undefined ? {} : { routing }),
        // A boolean, not the scheduler's outcome: `'failed'` (discovery refused) and `'unknown'` (no
        // catalog job, i.e. account preparation failed) are both "the models below are still the old
        // ones", and the editor can only say that one thing. The view itself stays valid either way,
        // so this rides along instead of failing the whole read.
        ...(refreshed === undefined ? {} : { catalogRefreshed: refreshed === 'refreshed' }),
      });
    })
    .query('/providers/:id/quota', quotaRefreshValidator, async (context) => {
      const id = context.req.param('id');
      if (!state.currentConfig().providers.some((provider) => provider.id === id)) {
        return context.json({ error: 'provider not found' }, 404);
      }
      try {
        const entry = await state.quotaCache.read(id, context.req.valid('json').refresh);
        return context.json({
          snapshot: entry.snapshot,
          sampledAt: entry.sampledAt,
          stale: entry.stale,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        });
      } catch (error) {
        // A provider whose plugin has no quota capability is a permanent 404, not a transient
        // upstream failure the card should keep retrying. A preparation failure wears the same
        // error type but is retryable, so only the permanent flag earns the 404.
        if (error instanceof OAuthQuotaCapabilityUnavailableError) {
          return context.json({ error: error.code }, error.permanent ? 404 : 502);
        }
        return context.json({ error: error instanceof Error ? error.message : 'OAUTH_QUOTA_READ_FAILED' }, 502);
      }
    })
    .get('/providers/:id', providerProbeValidator, async (context) => {
      const query = context.req.valid('query');
      const providers = await state.providerSummaries({
        filter: context.req.param('id'),
        probe: query.probe === 'true',
      });
      const provider = providers[0];
      if (provider === undefined) {
        return context.json({ error: 'provider not found' }, 404);
      }
      return context.json({ provider });
    });
