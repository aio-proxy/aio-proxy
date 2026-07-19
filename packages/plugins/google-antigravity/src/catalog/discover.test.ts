import { expect, spyOn, test } from "bun:test";
import {
  type AccountContext,
  CATALOG_DISCOVERY_TIMEOUT_MS,
  type ModelCatalog,
  type OAuthAdapter,
  type PluginDescriptor,
} from "@aio-proxy/plugin-sdk";
import { ANTIGRAVITY_DAILY, ANTIGRAVITY_PROD } from "../oauth/constants";
import { createGoogleAntigravityPlugin } from "../plugin";
import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from "../schema";
import { discoverAntigravityCatalog, normalizeDiscoveredModels } from "./discover";
import { CatalogDiscoveryError } from "./errors";
import { staticAntigravityCatalog } from "./snapshot";

const discoveryPath = "/v1internal:fetchAvailableModels";

test.each([
  [401, "authorization", false],
  [403, "authorization", false],
  [400, "request", false],
  [429, "retryable", true],
  [500, "retryable", true],
  [503, "retryable", true],
  [599, "retryable", true],
] as const)("classifies HTTP %i as %s", async (status, kind, snapshotEligible) => {
  const error = await captureError(async () => new Response(null, { status }));
  expect(error).toMatchObject({ kind, snapshotEligible, status });
});

test.each([
  ["network", async () => Promise.reject(new TypeError("network"))],
  ["timeout", async () => Promise.reject(new DOMException("timed out", "AbortError"))],
  ["invalid JSON", async () => new Response("not-json")],
  ["invalid schema", async () => Response.json({ models: [] })],
] as const)("classifies %s failures as snapshot-eligible without exposing their cause", async (_name, fetch) => {
  const error = await captureError(fetch);
  expect(error).toMatchObject({ kind: "retryable", snapshotEligible: true });
  expect(JSON.stringify(error)).not.toContain("network");
  expect(JSON.stringify(error)).not.toContain("not-json");
});

test("tries daily then prod only after a retryable endpoint outcome", async () => {
  const urls: string[] = [];
  const catalog = await discoverAntigravityCatalog(context(), {
    fetch: async (input) => {
      urls.push(String(input));
      return urls.length === 1
        ? new Response(null, { status: 503 })
        : Response.json({ models: { "dynamic-only": { displayName: "Dynamic" } } });
    },
  });
  expect(urls).toEqual([`${ANTIGRAVITY_DAILY}${discoveryPath}`, `${ANTIGRAVITY_PROD}${discoveryPath}`]);
  expect(catalog.language.map(({ id }) => id)).toEqual(["dynamic-only"]);
});

test("tries prod after daily returns HTTP 429", async () => {
  const urls: string[] = [];
  const catalog = await discoverAntigravityCatalog(context(), {
    fetch: async (input) => {
      urls.push(String(input));
      return urls.length === 1 ? new Response(null, { status: 429 }) : Response.json({ models: { prod: {} } });
    },
  });
  expect(urls).toEqual([`${ANTIGRAVITY_DAILY}${discoveryPath}`, `${ANTIGRAVITY_PROD}${discoveryPath}`]);
  expect(catalog.language.map(({ id }) => id)).toEqual(["prod"]);
});

test("fits both default endpoint attempts inside the shared host discovery budget", async () => {
  const endpointTimeouts: number[] = [];
  let timeoutCalls = 0;
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    endpointTimeouts.push(milliseconds);
    const controller = new AbortController();
    if (timeoutCalls++ === 0) queueMicrotask(() => controller.abort(new DOMException("timed out", "TimeoutError")));
    return controller.signal;
  });
  const urls: string[] = [];
  try {
    const catalog = await discoverAntigravityCatalog(context(), {
      fetch: async (input, init) => {
        urls.push(String(input));
        if (urls.length > 1) return Response.json({ models: { prod: {} } });
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    });
    expect(catalog.language.map(({ id }) => id)).toEqual(["prod"]);
  } finally {
    timeout.mockRestore();
  }
  expect(endpointTimeouts).toEqual([CATALOG_DISCOVERY_TIMEOUT_MS / 3, CATALOG_DISCOVERY_TIMEOUT_MS / 3]);
  expect(endpointTimeouts.reduce((total, value) => total + value, 0)).toBeLessThan(CATALOG_DISCOVERY_TIMEOUT_MS);
});

test.each([401, 403, 400])("does not try prod after terminal HTTP %i", async (status) => {
  let attempts = 0;
  await captureError(async () => {
    attempts += 1;
    return new Response(null, { status });
  });
  expect(attempts).toBe(1);
});

test("uses a custom base URL once even when discovery is retryable", async () => {
  const urls: string[] = [];
  const error = await captureError(
    async (input) => {
      urls.push(String(input));
      throw new TypeError("network");
    },
    { baseURL: "https://proxy.example.com" },
  );
  expect(error.kind).toBe("retryable");
  expect(urls).toEqual([`https://proxy.example.com${discoveryPath}`]);
});

test("sends the current credential, project, and Antigravity request headers", async () => {
  let request: Request | undefined;
  await discoverAntigravityCatalog(context(), {
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ models: { model: {} } });
    },
  });
  expect(request?.method).toBe("POST");
  expect(request?.headers.get("Authorization")).toBe("Bearer access-token");
  expect(request?.headers.get("Content-Type")).toBe("application/json");
  expect(request?.headers.get("User-Agent")).toMatch(/^antigravity\/hub\//u);
  expect(await request?.json()).toEqual({ project: "project-1" });
});

test("returns a dynamic non-empty catalog without merging snapshot-only models", async () => {
  const catalog = await discoverAntigravityCatalog(context(), {
    fetch: async () => Response.json({ models: { "dynamic-only": {} } }),
  });
  expect(catalog.language.map(({ id }) => id)).toEqual(["dynamic-only"]);
  expect(catalog.language.map(({ id }) => id)).not.toContain("gemini-3.5-flash-extra-low");
});

test("valid empty discovery never becomes snapshot-eligible", async () => {
  const error = await captureError(async () => Response.json({ models: {} }));
  expect(error).toMatchObject({ kind: "empty", snapshotEligible: false });
});

test("filters internal, denied, blank, and retired IDs but retains live effort targets", () => {
  const catalog = normalizeDiscoveredModels({
    chat_20706: {},
    chat_23310: {},
    tab_flash_lite_preview: {},
    tab_jump_flash_lite_preview: {},
    "gemini-2.5-pro": {},
    internal: { isInternal: true },
    " ": {},
    "gemini-3.1-pro-high": {},
    "gemini-pro-agent": { supportsThinking: true },
    "gemini-2.5-flash-thinking": { supportsThinking: true },
  });
  expect(catalog.map(({ id }) => id)).toEqual(["gemini-2.5-flash-thinking", "gemini-pro-agent"]);
});

test("normalizes discovery capability metadata with positive defaults and web-search hints", () => {
  const [model] = normalizeDiscoveredModels(
    {
      model: {
        displayName: "Model",
        supportsImages: true,
        supportsThinking: true,
        maxTokens: -1,
        maxOutputTokens: 0,
      },
    },
    ["model"],
  );
  expect(model).toEqual({
    id: "model",
    displayName: "Model",
    metadata: {
      antigravity: {
        supportsImages: true,
        supportsThinking: true,
        supportsWebSearch: true,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    },
  });
});

test("the static snapshot contains only the seven verified wire profiles", () => {
  const catalog = staticAntigravityCatalog();
  expect(catalog.language.map(({ id }) => id)).toEqual([
    "claude-opus-4-6-thinking",
    "claude-sonnet-4-6",
    "gemini-3-flash-agent",
    "gemini-3.1-pro-low",
    "gemini-3.5-flash-extra-low",
    "gemini-3.5-flash-low",
    "gemini-pro-agent",
  ]);
  expect(emptyModalities(catalog)).toBe(true);
});

test("adapter exposes a six-hour policy and fallback only for eligible first-login errors", async () => {
  const adapter = await adapterFrom(createGoogleAntigravityPlugin());
  expect(adapter.catalog.policy).toEqual({ kind: "ttl", ttlMs: 6 * 60 * 60 * 1_000 });
  const retryable = new CatalogDiscoveryError("retryable");
  expect(adapter.catalog.initialFallback?.(retryable)).toEqual(staticAntigravityCatalog());
  expect(adapter.catalog.initialFallback?.(new CatalogDiscoveryError("authorization"))).toBeUndefined();
  expect(adapter.catalog.initialFallback?.(new CatalogDiscoveryError("empty"))).toBeUndefined();
});

test("scheduled adapter discovery still throws instead of applying its initial fallback", async () => {
  const adapter = await adapterFrom(
    createGoogleAntigravityPlugin(undefined, { fetch: async () => new Response("invalid") }),
  );
  await expect(adapter.catalog.discover(context())).rejects.toMatchObject({
    kind: "retryable",
    snapshotEligible: true,
  });
});

async function captureError(
  fetch: typeof globalThis.fetch,
  options: GoogleAntigravityAccountOptions = {},
): Promise<CatalogDiscoveryError> {
  try {
    await discoverAntigravityCatalog(context(options), { fetch });
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogDiscoveryError);
    return error as CatalogDiscoveryError;
  }
  throw new Error("expected discovery to fail");
}

function context(
  options: GoogleAntigravityAccountOptions = {},
): AccountContext<GoogleAntigravityCredential, GoogleAntigravityAccountOptions> {
  const value: GoogleAntigravityCredential = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Number.MAX_SAFE_INTEGER,
    email: "person@example.com",
    projectId: "project-1",
  };
  return {
    options,
    signal: new AbortController().signal,
    credentials: {
      read: async () => ({ value, revision: 1 }),
      refresh: async () => ({ status: "superseded", snapshot: { value, revision: 1 } }),
    },
  };
}

function emptyModalities(catalog: ModelCatalog): boolean {
  return [catalog.image, catalog.embedding, catalog.speech, catalog.transcription, catalog.reranking].every(
    (models) => models.length === 0,
  );
}

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential>> {
  let adapter: OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential> | undefined;
  await descriptor.setup({ oauth: { register: (value) => (adapter = value as typeof adapter) } }, undefined);
  if (adapter === undefined) throw new Error("adapter was not registered");
  return adapter;
}
