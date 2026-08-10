import {
  type DashboardProviderDraftCatalogRequest,
  type DashboardProviderDraftCatalogRequestInput,
  DashboardProviderDraftCatalogRequestSchema,
  type DashboardProviderDraftTestRequest,
  type DashboardProviderDraftTestRequestInput,
  DashboardProviderDraftTestRequestSchema,
} from '@aio-proxy/types';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';

import type { ServerState } from '../../server-state';
import { loadProviderDraftCatalog, resolveProviderDraft, testProviderDraft } from './provider-draft-operations';

const invalidDraft = () => ({
  ok: false as const,
  error: { code: 'invalid_draft' as const, recoverable: true as const },
});

const catalogValidator = validator('json', (raw, context) => {
  const parsed = DashboardProviderDraftCatalogRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json(invalidDraft(), 400);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { json: DashboardProviderDraftCatalogRequestInput };
    out: { json: DashboardProviderDraftCatalogRequest };
  }
>;

const testValidator = validator('json', (raw, context) => {
  const parsed = DashboardProviderDraftTestRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json(invalidDraft(), 400);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { json: DashboardProviderDraftTestRequestInput };
    out: { json: DashboardProviderDraftTestRequest };
  }
>;

export const createDashboardProviderDraftRoutes = (state: ServerState) =>
  new Hono()
    .post('/providers/draft/catalog', catalogValidator, async (context) => {
      const { draft, persistedProviderId } = context.req.valid('json');
      const resolved = resolveProviderDraft(state, draft, persistedProviderId);
      if (!resolved.ok) {
        return context.json({ ok: false, error: { code: resolved.code, recoverable: true } }, 400);
      }
      return context.json(await loadProviderDraftCatalog(state, resolved.provider));
    })
    .post('/providers/draft/test', testValidator, async (context) => {
      const { draft, model, persistedProviderId } = context.req.valid('json');
      const resolved = resolveProviderDraft(state, draft, persistedProviderId);
      if (!resolved.ok) {
        return context.json({ ok: false, error: { code: resolved.code, recoverable: true } }, 400);
      }
      const result = await testProviderDraft(state, resolved.provider, model);
      return result.ok || result.error.code !== 'model_not_enabled' ? context.json(result) : context.json(result, 400);
    });
