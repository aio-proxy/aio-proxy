import { type Config, ConfigSchema } from "@aio-proxy/types";
import { Hono } from "hono";
import { createDashboardRoutes } from "./dashboard-routes/config";

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
  readonly port?: number;
  readonly host?: string;
};

const createRoutes = (config: Config) => {
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

  const dashboardRoutes = createDashboardRoutes(config);
  const routes = app.route("/dashboard", dashboardRoutes);
  return routes;
};

const routes = createRoutes(defaultConfig);

export const app = routes;
export type AppType = typeof routes;

export const bunServer = {
  hostname: serverDefaults.host,
  port: serverDefaults.port,
  fetch: app.fetch,
};

export const createServer = (options: CreateServerOptions): AppType =>
  createRoutes(ConfigSchema.parse(options.config));

export default bunServer;
