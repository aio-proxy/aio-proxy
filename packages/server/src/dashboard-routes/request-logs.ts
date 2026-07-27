import { getModels, type ModelsDevModel, modelRoutes } from '@aio-proxy/core';
import type { RequestLogsQuery } from '@aio-proxy/core/db';
import { DashboardRequestLogsPageSizeSchema, RequestOutcomeSchema } from '@aio-proxy/types';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import type { ServerState } from '../server-state';

const RequestLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().pipe(DashboardRequestLogsPageSizeSchema).default(50),
  startedAfter: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional(),
  completedBefore: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional(),
  requestId: z.string().trim().min(1).optional(),
  outcome: RequestOutcomeSchema.optional(),
  inboundProtocol: z.string().trim().min(1).optional(),
  requestedModelId: z.string().trim().min(1).optional(),
  finalProviderId: z.string().trim().min(1).optional(),
  finalModelId: z.string().trim().min(1).optional(),
  finalStatusCode: z.coerce.number().int().min(100).max(599).optional(),
});

const requestLogsValidator = validator('query', (raw, context) => {
  const parsed = RequestLogsQuerySchema.safeParse(raw);
  return parsed.success
    ? toRequestLogsQuery(parsed.data)
    : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
});

function toRequestLogsQuery(query: z.output<typeof RequestLogsQuerySchema>): RequestLogsQuery {
  return {
    page: query.page,
    pageSize: query.pageSize,
    ...(query.startedAfter === undefined ? {} : { startedAfter: query.startedAfter }),
    ...(query.completedBefore === undefined ? {} : { completedBefore: query.completedBefore }),
    ...(query.requestId === undefined ? {} : { requestId: query.requestId }),
    ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
    ...(query.inboundProtocol === undefined ? {} : { inboundProtocol: query.inboundProtocol }),
    ...(query.requestedModelId === undefined ? {} : { requestedModelId: query.requestedModelId }),
    ...(query.finalProviderId === undefined ? {} : { finalProviderId: query.finalProviderId }),
    ...(query.finalModelId === undefined ? {} : { finalModelId: query.finalModelId }),
    ...(query.finalStatusCode === undefined ? {} : { finalStatusCode: query.finalStatusCode }),
  };
}

export const createDashboardRequestLogsRoute = (state: ServerState) =>
  new Hono().get('/', requestLogsValidator, async (context) => {
    const data = state.traceStore.listRequestLogs(context.req.valid('query'));
    const providerNames = new Map(state.currentConfig().providers.map((provider) => [provider.id, provider.name]));
    const runtimeProviders = new Map(
      state.currentProviderSnapshot().providers.map((provider) => [provider.id, provider]),
    );
    const resolveUpstreamId = (item: (typeof data.items)[number]) => {
      const finalProvider = item.finalProviderId === undefined ? undefined : runtimeProviders.get(item.finalProviderId);
      return finalProvider === undefined
        ? item.requestedModelId
        : (modelRoutes(finalProvider).find((route) => route.alias === item.requestedModelId)?.modelId ??
            item.requestedModelId);
    };
    // Display names come from the catalog entry of whichever id we show; gather
    // every id up front so one batched lookup serves the whole page.
    const catalogIds = data.items.flatMap((item) => [
      item.requestedModelId,
      resolveUpstreamId(item),
      ...(item.finalModelId === undefined ? [] : [item.finalModelId]),
    ]);
    const catalog = await getModels(catalogIds).catch((): Record<string, ModelsDevModel | undefined> => ({}));
    return context.json({
      ...data,
      items: data.items.map((item) => {
        const finalProvider =
          item.finalProviderId === undefined ? undefined : runtimeProviders.get(item.finalProviderId);
        const requestedModelId = resolveUpstreamId(item);
        const requestedModelDisplayName =
          finalProvider?.modelMetadata?.[requestedModelId]?.displayName ??
          catalogDisplayName(catalog[item.requestedModelId]) ??
          catalogDisplayName(catalog[requestedModelId]);
        const finalProviderName =
          item.finalProviderId === undefined ? undefined : providerNames.get(item.finalProviderId);
        const finalModelDisplayName =
          item.finalModelId === undefined
            ? undefined
            : (finalProvider?.modelMetadata?.[item.finalModelId]?.displayName ??
              catalogDisplayName(catalog[item.finalModelId]));
        return {
          ...item,
          ...(requestedModelDisplayName === undefined ? {} : { requestedModelDisplayName }),
          ...(finalProviderName === undefined ? {} : { finalProviderName }),
          ...(finalModelDisplayName === undefined ? {} : { finalModelDisplayName }),
        };
      }),
    });
  });

// A catalog record whose human name equals its id carries no real display name;
// report undefined so callers fall back to their own alias/slug.
function catalogDisplayName(model: ModelsDevModel | undefined): string | undefined {
  return model === undefined || model.name === model.id ? undefined : model.name;
}
