import {
  NpmInstallError,
  NpmLockError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
  npmAdd,
} from "@aio-proxy/core";
import { Hono } from "hono";
import { ZodError, z } from "zod";
import type { ServerState } from "../server-state";

const OPENAI_SECRET_PATTERN = /^sk-[A-Za-z0-9_-]{20,}$/;
const BEARER_SECRET_PATTERN = /^Bearer\s+.+$/i;
const TOKEN_SECRET_PATTERN = /^Token\s+.+$/i;
const API_KEY_TEXT_PATTERN = /("?apiKey"?\s*:\s*")[^"]*(")/gi;
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|authorization|bearer|credential|password|secret|token)/i;

const ProviderInstallRequestSchema = z.object({
  npm: z.string().min(1),
  confirmed: z.literal(true),
  registry: z.url().optional(),
});

const maskSecret = (key: string, value: string): string => {
  if (OPENAI_SECRET_PATTERN.test(value)) {
    return "sk-****";
  }

  if (BEARER_SECRET_PATTERN.test(value) || TOKEN_SECRET_PATTERN.test(value)) {
    return "****";
  }

  if (SENSITIVE_KEY_PATTERN.test(key) || key.toLowerCase() === "headers") {
    return "****";
  }

  return value.replace(API_KEY_TEXT_PATTERN, "$1****$2");
};

export const redactSecrets = (value: unknown, key = "", insideHeaders = false): unknown => {
  if (typeof value === "string") {
    return insideHeaders ? "****" : maskSecret(key, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, key, insideHeaders));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSecrets(entryValue, entryKey, insideHeaders || entryKey.toLowerCase() === "headers"),
      ]),
    );
  }

  return value;
};

export const createDashboardRoutes = (state: ServerState) =>
  new Hono()
    .get("/config", (context) => context.json(redactSecrets(state.redactedConfig())))
    .get("/providers", async (context) => {
      const filter = context.req.query("filter");
      const probe = context.req.query("probe") === "true";
      const providers = await state.providerSummaries({ filter, probe });
      return context.json({ providers });
    })
    .get("/providers/:id", async (context) => {
      const providers = await state.providerSummaries({
        filter: context.req.param("id"),
        probe: context.req.query("probe") === "true",
      });
      const provider = providers[0];
      if (provider === undefined) {
        return context.json({ error: "provider not found" }, 404);
      }
      return context.json({ provider });
    })
    .post("/providers/install", async (context) => {
      try {
        const request = ProviderInstallRequestSchema.parse(await context.req.json());
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
      return context.json({ ok: false, error: result.error, stage: result.stage }, 409);
    });
