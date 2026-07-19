import { DashboardOAuthCallbackSubmissionSchema, DashboardOAuthSessionStartSchema } from "@aio-proxy/types";
import { Hono } from "hono";

import type { ServerState } from "../server-state";

import { OAuthCallbackError } from "../oauth-login-session/callback";

export const createDashboardOAuthLoginRoutes = (state: ServerState) =>
  new Hono()
    .post("/sessions", async (context) => {
      const parsed = DashboardOAuthSessionStartSchema.safeParse(await context.req.json().catch(() => undefined));
      if (!parsed.success) return context.json({ error: "validation failed", details: parsed.error.issues }, 400);
      if (state.configPath === undefined) return context.json({ error: "config file path is not configured" }, 409);
      return context.json({ session: state.oauthLoginSessions.start(parsed.data) }, 202);
    })
    .get("/sessions/:id", (context) => {
      const session = state.oauthLoginSessions.get(context.req.param("id"));
      return session === undefined
        ? context.json({ error: "OAuth session not found" }, 404)
        : context.json({ session });
    })
    .post("/sessions/:id/callback", async (context) => {
      const parsed = DashboardOAuthCallbackSubmissionSchema.safeParse(await context.req.json().catch(() => undefined));
      if (!parsed.success) return context.json({ error: "validation failed", details: parsed.error.issues }, 400);
      try {
        return context.json({
          session: state.oauthLoginSessions.submitCallback(context.req.param("id"), parsed.data.callbackUrl),
        });
      } catch (error) {
        if (error instanceof OAuthCallbackError) return context.json({ error: error.code }, 400);
        if (error instanceof Error && error.message === "OAUTH_SESSION_NOT_FOUND") {
          return context.json({ error: "OAuth session not found" }, 404);
        }
        throw error;
      }
    })
    .delete("/sessions/:id", (context) => {
      const session = state.oauthLoginSessions.cancel(context.req.param("id"));
      return session === undefined
        ? context.json({ error: "OAuth session not found" }, 404)
        : context.json({ session });
    });
