import { Hono } from "hono";
import type { ServerState } from "../server-state";

const OPENAI_SECRET_PATTERN = /^sk-[A-Za-z0-9_-]{20,}$/;
const BEARER_SECRET_PATTERN = /^Bearer\s+.+$/i;
const API_KEY_TEXT_PATTERN = /("?apiKey"?\s*:\s*")[^"]*(")/gi;

const maskSecret = (key: string, value: string): string => {
  if (OPENAI_SECRET_PATTERN.test(value)) {
    return "sk-****";
  }

  if (BEARER_SECRET_PATTERN.test(value)) {
    return "Bearer ****";
  }

  if (key.toLowerCase() === "apikey") {
    return "****";
  }

  return value.replace(API_KEY_TEXT_PATTERN, "$1****$2");
};

export const redactSecrets = (value: unknown, key = ""): unknown => {
  if (typeof value === "string") {
    return maskSecret(key, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSecrets(entryValue, entryKey),
      ]),
    );
  }

  return value;
};

export const createDashboardRoutes = (state: ServerState) =>
  new Hono()
    .get("/config", (context) =>
      context.json(redactSecrets(state.redactedConfig())),
    )
    .get("/providers", async (context) => {
      const filter = context.req.query("filter");
      const probe = context.req.query("probe") === "true";
      const providers = await state.providerSummaries({ filter, probe });
      return context.json({ providers });
    })
    .get(
      "/events",
      () =>
        new Response(state.events.stream(), {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream; charset=utf-8",
          },
        }),
    )
    .post("/reload", async (context) => {
      const result = await state.reload();
      if (result.ok) {
        return context.json({ ok: true, diff: result.diff });
      }
      return context.json(
        { ok: false, error: result.error, stage: result.stage },
        409,
      );
    });
