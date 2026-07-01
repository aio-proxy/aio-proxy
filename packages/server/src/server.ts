import { ConfigSchema } from "@aio-proxy/types";
import { Hono } from "hono";
import type { DashboardEventLimits } from "./dashboard-events";
import { createDashboardRoutes } from "./dashboard-routes/config";
import { createAnthropicMessagesRoutes } from "./routes/anthropic-messages";
import { createGeminiGenerateContentRoutes } from "./routes/gemini-generate-content";
import { createOpenAIChatRoutes } from "./routes/openai-chat";
import { createOpenAIResponsesRoutes } from "./routes/openai-responses";
import type { RuntimeProviderInstance } from "./runtime";
import { createServerState, type ServerState } from "./server-state";

export const serverDefaults = {
  host: "127.0.0.1",
  port: 22_078,
} as const;

const dashboardOrigins = new Set([
  "http://127.0.0.1:22079",
  "http://localhost:22079",
]);

const csrfMethods = new Set(["POST", "PUT", "DELETE"]);
const defaultConfig = ConfigSchema.parse({ providers: [] });

export type CreateServerOptions = {
  readonly config: unknown;
  readonly configPath?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly providerInstances?: readonly RuntimeProviderInstance[];
  readonly port?: number;
  readonly host?: string;
  readonly watchConfig?: boolean;
};

const createRoutes = (state: ServerState) => {
  const app = new Hono().get("/health", (context) =>
    context.json({
      status: "ok",
      uptime: performance.now() / 1_000,
      version: "0.0.0",
    }),
  );

  app.use("/dashboard/*", async (context, next) => {
    if (!csrfMethods.has(context.req.method)) {
      await next();
      return;
    }

    const origin = context.req.header("origin");
    if (origin === undefined || !dashboardOrigins.has(origin)) {
      return context.text("Forbidden", 403);
    }

    await next();
  });

  const dashboardRoutes = createDashboardRoutes(state);
  const anthropicMessagesRoutes = createAnthropicMessagesRoutes(state);
  const geminiGenerateContentRoutes = createGeminiGenerateContentRoutes(state);
  const openAIChatRoutes = createOpenAIChatRoutes(state);
  const openAIResponsesRoutes = createOpenAIResponsesRoutes(state);
  const routes = app
    .route("/", anthropicMessagesRoutes)
    .route("/", geminiGenerateContentRoutes)
    .route("/", openAIChatRoutes)
    .route("/", openAIResponsesRoutes)
    .route("/dashboard", dashboardRoutes);
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

export const createServer = (options: CreateServerOptions): AppType =>
  createRoutes(
    createServerState({
      config: ConfigSchema.parse(options.config),
      ...(options.configPath === undefined
        ? {}
        : { configPath: options.configPath }),
      ...(options.eventLimits === undefined
        ? {}
        : { eventLimits: options.eventLimits }),
      ...(options.providerInstances === undefined
        ? {}
        : { providerInstances: options.providerInstances }),
      ...(options.watchConfig === undefined
        ? {}
        : { watchConfig: options.watchConfig }),
    }),
  );

export default bunServer;
