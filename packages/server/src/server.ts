import { type ModelsDevCatalog, modelRoutes } from "@aio-proxy/core";
import { ConfigSchema, ProviderKind } from "@aio-proxy/types";
import type { Context } from "hono";
import { Hono } from "hono";
import type { DashboardAssets } from "./dashboard-assets";
import type { DashboardEventLimits } from "./dashboard-events";
import { createDashboardRoutes } from "./dashboard-routes/config";
import { createAnthropicMessagesRoutes } from "./routes/anthropic-messages";
import { createGeminiGenerateContentRoutes } from "./routes/gemini-generate-content";
import { createOpenAICompletionsRoutes } from "./routes/openai-completions";
import { createOpenAIResponsesRoutes } from "./routes/openai-responses";
import type { RuntimeProviderInput, RuntimeProviderInstance } from "./runtime";
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

async function listModels(state: ServerState) {
  const selected = new Map<string, { readonly modelId: string; readonly provider: RuntimeProviderInstance }>();

  for (const provider of state.currentProviderSnapshot().providers) {
    if (!provider.enabled) {
      continue;
    }
    for (const route of modelRoutes(provider)) {
      if (!selected.has(route.alias)) {
        selected.set(route.alias, { modelId: route.modelId, provider });
      }
    }
  }

  const needsCatalog = [...selected.values()].some(({ provider }) => provider.kind !== ProviderKind.OAuth);
  const catalog = needsCatalog ? await state.modelsDevCatalog().catch(() => undefined) : undefined;
  const data = [...selected].map(([id, route]) => ({
    capabilities: null,
    created: 0,
    created_at: unknownCreatedAt,
    display_name: modelDisplayName(id, route.modelId, route.provider, catalog),
    id,
    max_input_tokens: null,
    max_tokens: null,
    object: "model" as const,
    owned_by: route.provider.id,
    type: "model" as const,
  }));

  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
    object: "list" as const,
  };
}

function modelDisplayName(
  id: string,
  modelId: string,
  provider: RuntimeProviderInstance,
  catalog: ModelsDevCatalog | undefined,
): string {
  if (provider.kind === ProviderKind.OAuth) {
    return provider.modelMetadata?.[modelId]?.displayName ?? id;
  }
  return catalog?.displayName(id) ?? catalog?.displayName(modelId) ?? id;
}

const routes = createRoutes(createServerState({ config: defaultConfig }));

export const app = routes;
export type AppType = typeof routes;

export const bunServer = {
  hostname: serverDefaults.host,
  port: serverDefaults.port,
  fetch: app.fetch,
};

export const createServer = (options: CreateServerOptions): AppType => {
  const config = ConfigSchema.parse(options.config);
  return createRoutes(
    createServerState({
      config,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.dbHome === undefined ? {} : { dbHome: options.dbHome }),
      ...(options.eventLimits === undefined ? {} : { eventLimits: options.eventLimits }),
      ...(options.modelsDevCatalogTask === undefined ? {} : { modelsDevCatalogTask: options.modelsDevCatalogTask }),
      ...(options.providerInstances === undefined ? {} : { providerInstances: options.providerInstances }),
      ...(options.watchConfig === undefined ? {} : { watchConfig: options.watchConfig }),
    }),
    options.port ?? config.server.port,
    options.dashboardAssets,
  );
};

export default bunServer;
