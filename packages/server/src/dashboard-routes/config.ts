import type { RequestLogsQuery } from "@aio-proxy/core/db";

import {
  AccountCleanupPendingError,
  NpmInstallError,
  NpmLockError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
  npmAdd,
  PendingAccountOperationConflictError,
} from "@aio-proxy/core";
import {
  DashboardRequestLogsPageSizeSchema,
  type ProviderMutationBody,
  ProviderMutationBodySchema,
  RequestOutcomeSchema,
  UsageOverviewGroupBySchema,
  UsageOverviewMetricSchema,
  UsageOverviewRangeSchema,
} from "@aio-proxy/types";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { ZodError, z } from "zod";

import type { DashboardAuthentication } from "../dashboard-auth";
import type { ServerState } from "../server-state";

import { ConfigReloadRejectedError } from "../config-store";
import { isTrustedProviderPackage } from "../provider-package-trust";
import { createDashboardEventsRoute } from "./events";
import { createDashboardOAuthLoginRoutes } from "./oauth-login";
import {
  insertProvider,
  ProviderAlreadyExistsError,
  ProviderNotFoundError,
  replaceOAuthProvider,
  replaceProvider,
} from "./provider-mutation";
import { providerPackageQueryValidator, providerPackageStatus } from "./provider-package-metadata";
import { redactSecrets } from "./provider-secrets";

const ProviderInstallRequestSchema = z.object({
  npm: z.string().min(1),
  confirmed: z.boolean().optional(),
  registry: z.url().optional(),
});

export { redactSecrets } from "./provider-secrets";

type MutationParseResult =
  | { readonly ok: true; readonly body: ProviderMutationBody }
  | { readonly ok: false; readonly status: 400; readonly payload: Record<string, unknown> };

// oauth bodies 400 here with no explicit check: ProviderMutationBodySchema's union omits kind "oauth".
const parseMutationBody = (raw: unknown): MutationParseResult => {
  const parsed = ProviderMutationBodySchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, payload: { error: "validation failed", details: parsed.error.issues } };
  }
  return { ok: true, body: parsed.data };
};

const providerMutationValidator = validator("json", (raw, context): ProviderMutationBody | Response => {
  const parsed = parseMutationBody(raw);
  return parsed.ok ? parsed.body : context.json(parsed.payload, parsed.status);
});

const probeKey = "probe";

const providerProbeValidator = validator("query", (raw): { readonly probe?: string } =>
  typeof raw[probeKey] === "string" ? { probe: raw[probeKey] } : {},
);

const UsageOverviewQuerySchema = z.object({
  range: UsageOverviewRangeSchema.default("24h"),
  metric: UsageOverviewMetricSchema.default("cost"),
  groupBy: UsageOverviewGroupBySchema.default("model"),
});

const usageOverviewValidator = validator("query", (raw, context) => {
  const parsed = UsageOverviewQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: "validation failed", details: parsed.error.issues }, 400);
});

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

export const createDashboardRoutes = (state: ServerState, auth: DashboardAuthentication) =>
  new Hono()
    .get("/config", (context) => context.json(redactSecrets(state.currentConfig())))
    .get("/oauth/capabilities", (context) => context.json({ capabilities: state.oauthCapabilities() }))
    .route("/oauth", createDashboardOAuthLoginRoutes(state))
    .get("/providers", async (context) => {
      const filter = context.req.query("filter");
      const probe = context.req.query("probe") === "true";
      const providers = await state.providerSummaries({ filter, probe });
      return context.json({ providers });
    })
    .get("/providers/package-status", providerPackageQueryValidator, async (context) =>
      context.json(await providerPackageStatus(context.req.valid("query").npm)),
    )
    .get("/providers/:id/edit-view", (context) => {
      const id = context.req.param("id");
      const data = state.currentConfig().providers.find((entry) => entry.id === id);
      if (data === undefined) {
        return context.json({ error: "provider not found" }, 404);
      }
      const provider = redactSecrets(data) as typeof data & { hasApiKey: boolean };
      provider.hasApiKey = false;
      if ("apiKey" in provider) {
        provider.hasApiKey = typeof provider.apiKey === "string" && provider.apiKey !== "";
        delete provider.apiKey;
      }
      const oauth = provider.kind === "oauth" ? state.oauthProviderEditView(id) : undefined;
      return context.json({ provider, ...(oauth === undefined ? {} : { oauth }) });
    })
    .post("/providers", providerMutationValidator, async (context) => {
      if (state.configPath === undefined) {
        return context.json({ error: "config file path is not configured" }, 409);
      }
      const body = context.req.valid("json");
      if (body.kind === "oauth") {
        return context.json({ error: "OAuth providers must be created through login" }, 400);
      }
      const { id, ...bodyRest } = body;
      const providerData: Record<string, unknown> = { ...bodyRest };
      try {
        await state.configStore.mutateProviders((record) => insertProvider(record, id, providerData));
      } catch (error) {
        if (error instanceof ProviderAlreadyExistsError) {
          return context.json({ error: "provider id already exists", id: error.providerId }, 409);
        }
        if (error instanceof ConfigReloadRejectedError) {
          return context.json({ error: "config rejected", detail: error.message }, 422);
        }
        throw error;
      }
      const summaries = await state.providerSummaries({ filter: id, probe: false });
      const provider = summaries[0];
      if (provider === undefined) {
        return context.json({ error: "provider summary not found" }, 500);
      }
      return context.json({ provider }, 201);
    })
    .put("/providers/:id", providerMutationValidator, async (context) => {
      if (state.configPath === undefined) {
        return context.json({ error: "config file path is not configured" }, 409);
      }
      const id = context.req.param("id");
      const body = context.req.valid("json");
      if (body.id !== id) {
        return context.json({ error: "provider rename not supported" }, 400);
      }
      const { id: _id, ...bodyRest } = body;
      const providerData: Record<string, unknown> = { ...bodyRest };
      try {
        await state.configStore.mutateProviders((record) =>
          body.kind === "oauth"
            ? replaceOAuthProvider(record, id, providerData)
            : replaceProvider(record, id, providerData),
        );
      } catch (error) {
        if (error instanceof ProviderNotFoundError) {
          return context.json({ error: "provider not found" }, 404);
        }
        if (error instanceof ConfigReloadRejectedError) {
          return context.json({ error: "config rejected", detail: error.message }, 422);
        }
        throw error;
      }
      const summaries = await state.providerSummaries({ filter: id, probe: false });
      const provider = summaries[0];
      if (provider === undefined) {
        return context.json({ error: "provider summary not found" }, 500);
      }
      return context.json({ provider });
    })
    .delete("/providers/:id", async (context) => {
      if (state.configPath === undefined) {
        return context.json({ error: "config file path is not configured" }, 409);
      }
      const id = context.req.param("id");
      if ((await state.providerSummaries({ filter: id, probe: false })).length === 0) {
        return context.json({ error: "provider not found" }, 404);
      }
      try {
        await state.configStore.deleteProvider(id);
      } catch (error) {
        if (error instanceof AccountCleanupPendingError || error instanceof PendingAccountOperationConflictError) {
          return context.json({ error: "provider account cleanup pending", id }, 409);
        }
        throw error;
      }
      return context.json({ ok: true, id });
    })
    .get("/providers/:id", providerProbeValidator, async (context) => {
      const query = context.req.valid("query");
      const providers = await state.providerSummaries({
        filter: context.req.param("id"),
        probe: query.probe === "true",
      });
      const provider = providers[0];
      if (provider === undefined) {
        return context.json({ error: "provider not found" }, 404);
      }
      return context.json({ provider });
    })
    .get("/usage", usageOverviewValidator, (context) => {
      const query = context.req.valid("query");
      return context.json(state.requestLog.overview(query));
    })
    .get("/logs", requestLogsValidator, (context) => context.json(state.requestLog.list(context.req.valid("query"))))
    .post("/providers/install", async (context) => {
      try {
        const request = ProviderInstallRequestSchema.parse(await context.req.json());
        if (!isTrustedProviderPackage(request.npm) && request.confirmed !== true) {
          return context.json({ code: "confirmation_required", error: "provider install requires confirmation" }, 400);
        }
        const installed = await npmAdd(request.npm, request.registry);
        return context.json({ installed });
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) {
          return context.json(
            {
              error: "provider install requires { npm, confirmed: true, registry? }",
            },
            400,
          );
        }
        if (error instanceof NpmPackageNameError) {
          return context.json({ error: error.message }, 400);
        }
        if (error instanceof NpmLockError) {
          return context.json({ error: error.message }, 423);
        }
        if (
          error instanceof NpmInstallError ||
          error instanceof NpmPackageEntrypointError ||
          error instanceof NpmPackageJsonError
        ) {
          return context.json({ error: error.message }, 502);
        }
        throw error;
      }
    })
    .route("/events", createDashboardEventsRoute(state, auth))
    .post("/reload", async (context) => {
      const result = await state.reload();
      if (result.ok) {
        return context.json({ ok: true, diff: result.diff });
      }
      return context.json({ ok: false, error: result.error, stage: result.stage }, 409);
    });
