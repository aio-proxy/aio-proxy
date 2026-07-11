import {
  NpmInstallError,
  NpmLockError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
  npmAdd,
} from "@aio-proxy/core";
import { type ProviderMutationBody, ProviderMutationBodySchema } from "@aio-proxy/types";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { ZodError, z } from "zod";
import { ConfigReloadRejectedError } from "../config-store";
import type { ServerState } from "../server-state";
import {
  insertProvider,
  ProviderAlreadyExistsError,
  ProviderNotFoundError,
  replaceProvider,
} from "./provider-mutation";
import { redactSecrets } from "./provider-secrets";

const ProviderInstallRequestSchema = z.object({
  npm: z.string().min(1),
  confirmed: z.literal(true),
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

const providerProbeValidator = validator("query", (raw): { readonly probe?: string } => ({
  ...(typeof raw[probeKey] === "string" ? { probe: raw[probeKey] } : {}),
}));

export const createDashboardRoutes = (state: ServerState) =>
  new Hono()
    .get("/config", (context) => context.json(redactSecrets(state.redactedConfig())))
    .get("/providers", async (context) => {
      const filter = context.req.query("filter");
      const probe = context.req.query("probe") === "true";
      const providers = await state.providerSummaries({ filter, probe });
      return context.json({ providers });
    })
    .get("/providers/:id/edit-view", (context) => {
      const id = context.req.param("id");
      const data = state.redactedConfig().providers.find((entry) => entry.id === id);
      if (data === undefined) {
        return context.json({ error: "provider not found" }, 404);
      }
      const provider = redactSecrets(data) as typeof data & { hasApiKey: boolean };
      provider.hasApiKey = false;
      if ("apiKey" in provider) {
        provider.hasApiKey = typeof provider.apiKey === "string" && provider.apiKey !== "";
        delete provider.apiKey;
      }
      return context.json({ provider });
    })
    .post("/providers", providerMutationValidator, async (context) => {
      if (state.configPath === undefined) {
        return context.json({ error: "config file path is not configured" }, 409);
      }
      const body = context.req.valid("json");
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
        await state.configStore.mutateProviders((record) => replaceProvider(record, id, providerData));
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
      if (!state.redactedConfig().providers.some((entry) => entry.id === id)) {
        return context.json({ error: "provider not found" }, 404);
      }
      await state.configStore.mutateProviders((record) => {
        const { [id]: _removed, ...rest } = record;
        return rest;
      });
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
