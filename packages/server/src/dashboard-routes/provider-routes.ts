import { Hono } from 'hono';
import { validator } from 'hono/validator';

import type { ServerState } from '../server-state';
import { providerPackageQueryValidator, providerPackageStatus } from './provider-package-metadata';
import { redactSecrets } from './provider-secrets';

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
      const data = state.currentConfig().providers.find((entry) => entry.id === id);
      if (data === undefined) {
        return context.json({ error: 'provider not found' }, 404);
      }
      const provider = redactSecrets(data) as typeof data & { hasApiKey: boolean };
      provider.hasApiKey = false;
      if ('apiKey' in provider) {
        provider.hasApiKey = typeof provider.apiKey === 'string' && provider.apiKey !== '';
        delete provider.apiKey;
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
