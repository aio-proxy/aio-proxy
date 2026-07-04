import { ConfigSchema } from "@aio-proxy/types";
import type { Context } from "hono";
import { Hono } from "hono";
import type { DashboardAssets } from "./dashboard-assets";
import type { DashboardEventLimits } from "./dashboard-events";
import { createDashboardRoutes } from "./dashboard-routes/config";
import { createAnthropicMessagesRoutes } from "./routes/anthropic-messages";
import { createGeminiGenerateContentRoutes } from "./routes/gemini-generate-content";
import { createOpenAICompletionsRoutes } from "./routes/openai-completions";
import { createOpenAIResponsesRoutes } from "./routes/openai-responses";
import type { RuntimeProviderInstance } from "./runtime";
import { createServerState, type ServerState } from "./server-state";

export const serverDefaults = {
  host: "127.0.0.1",
  port: 22_078,
} as const;

const dashboardOrigins = (port: number) => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

const csrfMethods = new Set(["POST", "PUT", "DELETE"]);
const defaultConfig = ConfigSchema.parse({ providers: [] });

export type CreateServerOptions = {
  readonly config: unknown;
  readonly configPath?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly providerInstances?: readonly RuntimeProviderInstance[];
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
  app.get("/v1/models", (context) =>
    context.json({
      object: "list",
      data: state.currentProviderSnapshot().providers.flatMap((provider) =>
        (provider.models ?? []).map((model) => ({
          id: typeof model === "string" ? model : model.alias,
          object: "model",
          owned_by: provider.id,
        })),
      ),
    }),
  );
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
      ...(options.eventLimits === undefined ? {} : { eventLimits: options.eventLimits }),
      ...(options.providerInstances === undefined ? {} : { providerInstances: options.providerInstances }),
      ...(options.watchConfig === undefined ? {} : { watchConfig: options.watchConfig }),
    }),
    options.port ?? config.server.port,
    options.dashboardAssets,
  );
};

export default bunServer;
