import { Hono } from 'hono';
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
    .get('/providers/:id/edit-view', (context) => {
      const id = context.req.param('id');
      // Real values on purpose: the editor round-trips this entry straight back
      // through the mutation endpoint, and every masked field it had to restore
      // was a source of Bearer '****' bugs. GET /config and the CLI still mask.
      // Pre-extend on purpose: the editor writes this entry straight back, so a resolved
      // `metadata.extend` would land on disk as a frozen copy of its models.dev entry.
      const provider = state.configBeforeExtend().providers.find((entry) => entry.id === id);
      if (provider === undefined) {
        return context.json({ error: 'provider not found' }, 404);
      }
      const oauth = provider.kind === 'oauth' ? state.oauthProviderEditView(id) : undefined;
      return context.json({ provider, ...(oauth === undefined ? {} : { oauth }) });
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
