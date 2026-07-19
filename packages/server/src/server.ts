import type { ModelInfo as AnthropicModelInfo } from "@anthropic-ai/sdk/resources/models";
import type { Context } from "hono";
import type { Model as OpenAIModel } from "openai/resources/models";

import { type ModelsDevCapabilities, type ModelsDevCatalog, modelRoutes } from "@aio-proxy/core";
import { ConfigSchema, ProviderKind } from "@aio-proxy/types";
import { getUnixTime, isValid, parseISO } from "date-fns";
import { filter, flatMap, map, pipe, uniqBy } from "es-toolkit/fp";
import { Hono } from "hono";

import type { DashboardAssets } from "./dashboard-assets";
import type { DashboardEventLimits } from "./dashboard-events";
import type { RuntimeProviderInput, RuntimeProviderInstance } from "./runtime";
import type { ServerLogSink } from "./server-log";

import { createDashboardRoutes } from "./dashboard-routes/config";
import { createAnthropicMessagesRoutes } from "./routes/anthropic-messages";
import { createGeminiGenerateContentRoutes } from "./routes/gemini-generate-content";
import { createOpenAICompletionsRoutes } from "./routes/openai-completions";
import { createOpenAIResponsesRoutes } from "./routes/openai-responses";
import { createServerState, type ServerState } from "./server-state";

export const serverDefaults = {
  host: "127.0.0.1",
  port: 22_078,
} as const;

const dashboardOrigins = (port: number) => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

const csrfMethods = new Set(["POST", "PUT", "DELETE"]);
const defaultConfig = ConfigSchema.parse({ providers: {} });

export type CreateServerOptions = {
  readonly config: unknown;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly modelsDevCatalogTask?: () => Promise<ModelsDevCatalog | undefined>;
  readonly providerInstances?: readonly RuntimeProviderInput[];
  readonly port?: number;
  readonly host?: string;
  readonly dashboardAssets?: DashboardAssets;
  readonly logger?: ServerLogSink;
  readonly watchConfig?: boolean;
};

const createRoutes = (
  state: ServerState,
  dashboardOriginPort: number = serverDefaults.port,
  dashboardAssets?: DashboardAssets,
) => {
  const app = new Hono().get("/health", (context) =>
    context.json({
      status: "ok",
      uptime: performance.now() / 1_000,
      version: "0.0.0",
    }),
  );
  app.get("/v1/models", async (context) => context.json(await listModels(state)));
  const allowedDashboardOrigins = dashboardOrigins(dashboardOriginPort);

  app.use("/dashboard/api/*", async (context, next) => {
    if (!csrfMethods.has(context.req.method)) {
      await next();
      return;
    }

    const origin = context.req.header("origin");
    if (origin === undefined || !allowedDashboardOrigins.has(origin)) {
      return context.text("Forbidden", 403);
    }

    await next();
  });

  const dashboardRoutes = createDashboardRoutes(state);
  const anthropicMessagesRoutes = createAnthropicMessagesRoutes(state);
  const geminiGenerateContentRoutes = createGeminiGenerateContentRoutes(state);
  const openAICompletionsRoutes = createOpenAICompletionsRoutes(state);
  const openAIResponsesRoutes = createOpenAIResponsesRoutes(state);
  const routes = app
    .route("/", anthropicMessagesRoutes)
    .route("/", geminiGenerateContentRoutes)
    .route("/", openAICompletionsRoutes)
    .route("/", openAIResponsesRoutes)
    .route("/dashboard/api", dashboardRoutes);

  if (dashboardAssets !== undefined) {
    const dashboardIndex = async (context: Context) => (await dashboardAssets("index.html")) ?? context.notFound();
    routes
      .get("/dashboard", dashboardIndex)
      .get("/dashboard/", dashboardIndex)
      .get(
        "/dashboard/static/*",
        async (context) =>
          (await dashboardAssets(context.req.path.replace(/^\/dashboard\//u, ""))) ?? context.notFound(),
      )
      .all("/dashboard/static/*", (context) => context.notFound())
      .all("/dashboard/api", (context) => context.notFound())
      .all("/dashboard/api/*", (context) => context.notFound())
      .get("/dashboard/*", dashboardIndex);
  }

  return routes;
};

const unknownCreatedAt = "1970-01-01T00:00:00Z";
type ModelListItem = OpenAIModel &
  Omit<AnthropicModelInfo, "capabilities"> & {
    readonly capabilities: ModelsDevCapabilities | null;
  };

async function listModels(state: ServerState) {
  const lease = state.acquireProviderSnapshot();
  try {
    const selected = pipe(
      lease.snapshot.providers,
      filter((provider) => provider.enabled),
      flatMap((provider) =>
        modelRoutes(provider).map((route) => ({ id: route.alias, modelId: route.modelId, provider })),
      ),
      uniqBy(({ id }) => id),
    );

    const catalog = selected.length === 0 ? undefined : await state.modelsDevCatalog().catch(() => undefined);

    return pipe(
      selected,
      map(({ id, modelId, provider }): ModelListItem => {
        const aliasMetadata = catalog?.metadata(id);
        const upstreamMetadata =
          id === modelId || aliasMetadata?.displayName !== undefined ? undefined : catalog?.metadata(modelId);
        const metadata = aliasMetadata ?? upstreamMetadata;
        const timestamps = modelTimestamps(metadata?.releaseDate);
        return {
          capabilities: metadata?.capabilities ?? null,
          created: timestamps.created,
          created_at: timestamps.createdAt,
          display_name: modelDisplayName(
            id,
            modelId,
            provider,
            aliasMetadata?.displayName ?? upstreamMetadata?.displayName,
          ),
          id,
          max_input_tokens: metadata?.maxInputTokens ?? null,
          max_tokens: metadata?.maxTokens ?? null,
          object: "model",
          owned_by: provider.id,
          type: "model",
        };
      }),
      (data) => ({
        data,
        first_id: data[0]?.id ?? null,
        has_more: false,
        last_id: data.at(-1)?.id ?? null,
        object: "list" as const,
      }),
    );
  } finally {
    lease.release();
  }
}

function modelDisplayName(
  id: string,
  modelId: string,
  provider: RuntimeProviderInstance,
  catalogDisplayName: string | undefined,
): string {
  if (provider.kind === ProviderKind.OAuth) {
    return provider.modelMetadata?.[modelId]?.displayName ?? catalogDisplayName ?? id;
  }
  return catalogDisplayName ?? id;
}

function modelTimestamps(releaseDate: string | undefined): { readonly created: number; readonly createdAt: string } {
  if (releaseDate === undefined) {
    return { created: 0, createdAt: unknownCreatedAt };
  }
  const normalizedDate = releaseDate.length === 7 ? `${releaseDate}-01` : releaseDate;
  const date = parseISO(`${normalizedDate}T00:00:00Z`);
  if (!isValid(date)) {
    return { created: 0, createdAt: unknownCreatedAt };
  }
  return { created: getUnixTime(date), createdAt: date.toISOString() };
}

const routes = createRoutes(await createServerState({ config: defaultConfig }));

export const app = routes;
export type AppType = typeof routes;

export const bunServer = {
  hostname: serverDefaults.host,
  port: serverDefaults.port,
  fetch: app.fetch,
};

export const createServer = async (options: CreateServerOptions): Promise<AppType> => {
  const config = ConfigSchema.parse(options.config);
  return createRoutes(
    await createServerState({
      config,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.dbHome === undefined ? {} : { dbHome: options.dbHome }),
      ...(options.eventLimits === undefined ? {} : { eventLimits: options.eventLimits }),
      ...(options.modelsDevCatalogTask === undefined ? {} : { modelsDevCatalogTask: options.modelsDevCatalogTask }),
      ...(options.providerInstances === undefined ? {} : { providerInstances: options.providerInstances }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.watchConfig === undefined ? {} : { watchConfig: options.watchConfig }),
    }),
    options.port ?? config.server.port,
    options.dashboardAssets,
  );
};

export default bunServer;
