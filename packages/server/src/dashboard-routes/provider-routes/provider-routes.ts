import { isPlainObject } from 'es-toolkit/predicate';
import { Hono } from 'hono';
import { validator } from 'hono/validator';

import { OAuthQuotaCapabilityUnavailableError } from '../../plugin-quota';
import type { ServerState } from '../../server-state';
import { providerPackageQueryValidator, providerPackageStatus } from '../provider-package-metadata';
import { providerRoutingRevision } from '../provider-routing-mutation';

const probeKey = 'probe';

const providerProbeValidator = validator('query', (raw): { readonly probe?: string } =>
  typeof raw[probeKey] === 'string' ? { probe: raw[probeKey] } : {},
);

// The body is optional and the only field that matters is the manual-refresh escape hatch.
const quotaRefreshValidator = validator('json', (raw): { readonly refresh: boolean } => ({
  refresh: isPlainObject(raw) && raw['refresh'] === true,
}));

export const createDashboardProviderReadRoutes = (state: ServerState) =>
  new Hono()
    .get('/providers', async (context) => {
      const filter = context.req.query('filter');
      const probe = context.req.query('probe') === 'true';
      const providers = await state.providerSummaries({ filter, probe });
      const providerIds = state.currentConfig().providers.map((provider) => provider.id);
      const rawProviders =
        state.configStore.file === undefined ? {} : ((await state.configStore.file.read())['providers'] ?? {});
      return context.json({
        providers,
        routingRevision: providerRoutingRevision(isPlainObject(rawProviders) ? rawProviders : {}, providerIds),
      });
    })
    .get('/providers/package-status', providerPackageQueryValidator, async (context) =>
      context.json(await providerPackageStatus(context.req.valid('query').npm)),
    )
    .get('/providers/:id/edit-view', async (context) => {
      const id = context.req.param('id');
      // Real values on purpose: the editor round-trips this entry straight back
      // through the mutation endpoint, and every masked field it had to restore
      // was a source of Bearer '****' bugs. GET /config and the CLI still mask.
      const provider = state.currentConfig().providers.find((entry) => entry.id === id);
      if (provider === undefined) {
        return context.json({ error: 'provider not found' }, 404);
      }
      const oauth = provider.kind === 'oauth' ? state.oauthProviderEditView(id) : undefined;
      const routing = await state.modelRouting.providerNumberViews(id);
      return context.json({
        provider,
        ...(oauth === undefined ? {} : { oauth }),
        ...(routing === undefined ? {} : { routing }),
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
