import type { RequestLogsQuery } from "@aio-proxy/core/db";

import { modelRoutes } from "@aio-proxy/core";
import { DashboardRequestLogsPageSizeSchema, RequestOutcomeSchema } from "@aio-proxy/types";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";

import type { ServerState } from "../server-state";

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

const requestLogsValidator = validator("query", (raw, context) => {
  const parsed = RequestLogsQuerySchema.safeParse(raw);
  return parsed.success
    ? toRequestLogsQuery(parsed.data)
    : context.json({ error: "validation failed", details: parsed.error.issues }, 400);
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
  new Hono().get("/", requestLogsValidator, async (context) => {
    const data = state.requestLog.list(context.req.valid("query"));
    const catalog = await state.modelsDevCatalog().catch(() => undefined);
    const providerNames = new Map(state.currentConfig().providers.map((provider) => [provider.id, provider.name]));
    const runtimeProviders = new Map(
      state.currentProviderSnapshot().providers.map((provider) => [provider.id, provider]),
    );
    return context.json({
      ...data,
      items: data.items.map((item) => {
        const finalProvider =
          item.finalProviderId === undefined ? undefined : runtimeProviders.get(item.finalProviderId);
        const requestedModelId =
          finalProvider === undefined
            ? item.requestedModelId
            : (modelRoutes(finalProvider).find((route) => route.alias === item.requestedModelId)?.modelId ??
              item.requestedModelId);
        const requestedModelDisplayName =
          finalProvider?.modelMetadata?.[requestedModelId]?.displayName ??
          catalog?.metadata(item.requestedModelId)?.displayName ??
          catalog?.metadata(requestedModelId)?.displayName;
        const finalProviderName =
          item.finalProviderId === undefined ? undefined : providerNames.get(item.finalProviderId);
        const finalModelDisplayName =
          item.finalModelId === undefined
            ? undefined
            : (finalProvider?.modelMetadata?.[item.finalModelId]?.displayName ??
              catalog?.metadata(item.finalModelId)?.displayName);
        return {
          ...item,
          ...(requestedModelDisplayName === undefined ? {} : { requestedModelDisplayName }),
          ...(finalProviderName === undefined ? {} : { finalProviderName }),
          ...(finalModelDisplayName === undefined ? {} : { finalModelDisplayName }),
        };
      }),
    });
  });
