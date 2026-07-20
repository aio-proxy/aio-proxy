import type { Context, MiddlewareHandler } from "hono";

import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { validator } from "hono/validator";

import type { DashboardAuthentication } from "./dashboard-auth";

const COOKIE_NAME = "aio_proxy_dashboard_session";
const COOKIE_PATH = "/dashboard";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const passwordBodyValidator = validator("json", (value, context): { readonly password: string } | Response =>
  isPasswordBody(value) ? value : context.json({ error: "invalid_request" }, 400),
);

export const createDashboardAuthRoutes = (auth: DashboardAuthentication) =>
  new Hono()
    .get("/session", (context) =>
      context.json({
        status: !auth.available()
          ? ("unavailable" as const)
          : !auth.enabled()
            ? ("disabled" as const)
            : auth.verify(getCookie(context, COOKIE_NAME))
              ? ("authenticated" as const)
              : ("unauthenticated" as const),
      }),
    )
    .post("/login", passwordBodyValidator, async (context) => {
      const body = context.req.valid("json");
      const result = await auth.login(body.password, clientId(context));
      if (result.status === "unavailable") return context.json({ error: "dashboard_unavailable" }, 503);
      if (result.status === "disabled") return context.json({ error: "authentication_disabled" }, 409);
      if (result.status === "invalid") return context.json({ error: "invalid_password" }, 401);
      if (result.status === "rate-limited") {
        context.header("retry-after", String(result.retryAfterSeconds));
        return context.json({ error: "rate_limited", retryAfterSeconds: result.retryAfterSeconds }, 429);
      }
      setCookie(context, COOKIE_NAME, result.token, {
        expires: new Date(result.expiresAt),
        httpOnly: true,
        maxAge: SESSION_MAX_AGE_SECONDS,
        path: COOKIE_PATH,
        sameSite: "Strict",
      });
      return context.json({ ok: true, expiresAt: new Date(result.expiresAt).toISOString() });
    })
    .post("/logout", (context) => {
      deleteCookie(context, COOKIE_NAME, { path: COOKIE_PATH, sameSite: "Strict" });
      return context.json({ ok: true });
    });

export const requireDashboardAuthentication =
  (auth: DashboardAuthentication): MiddlewareHandler =>
  async (context, next) => {
    if (!auth.available()) return context.json({ error: "dashboard_unavailable" }, 503);
    if (!auth.enabled() || auth.verify(getCookie(context, COOKIE_NAME))) {
      await next();
      return;
    }
    return context.json({ error: "authentication_required" }, 401);
  };

export const requireDashboardLoopback: MiddlewareHandler = async (context, next) => {
  const address = requestAddress(context);
  if (address !== undefined && !isLoopbackAddress(address)) return context.notFound();
  await next();
};

function isPasswordBody(value: unknown): value is { readonly password: string } {
  return typeof value === "object" && value !== null && "password" in value && typeof value.password === "string";
}

function clientId(context: Context): string {
  return requestAddress(context) ?? "loopback";
}

function requestAddress(context: Context): string | undefined {
  const server = context.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  return server?.requestIP?.(context.req.raw)?.address;
}

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}
