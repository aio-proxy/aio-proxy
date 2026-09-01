import { isPlainObject } from 'es-toolkit/predicate';
import { Hono } from 'hono';
import { etag } from 'hono/etag';
import { validator } from 'hono/validator';

import type { ServerState } from '../server-state';
import { providerPackageQueryValidator, providerPackageStatus } from './provider-package-metadata';

const probeKey = 'probe';

const providerProbeValidator = validator('query', (raw): { readonly probe?: string } =>
  typeof raw[probeKey] === 'string' ? { probe: raw[probeKey] } : {},
);

export const createDashboardProviderReadRoutes = (state: ServerState) =>
  new Hono()
    .get('/providers', async (context) => {
      const filter = context.req.query('filter');
      const probe = context.req.query('probe') === 'true';
      const providers = await state.providerSummaries({ filter, probe });
      return context.json({ providers });
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
    .use('/providers/:id/quota', etag())
    .query('/providers/:id/quota', async (context) => {
      const body: unknown = await context.req.json().catch(() => ({}));
      const refresh = isPlainObject(body) && body['refresh'] === true;
      try {
        const entry = await state.quotaCache.read(context.req.param('id'), context.req.raw.signal, refresh);
        return context.json({
          snapshot: entry.snapshot,
          sampledAt: entry.sampledAt,
          stale: entry.stale,
          ...(entry.error === undefined ? {} : { error: entry.error }),
        });
      } catch (error) {
        // The cache only throws when it has no snapshot at all: an unsupported provider, a missing
        // account, or a first read that failed. All are upstream problems, not client mistakes.
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
