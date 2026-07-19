import type { AccountContext } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { KimiCredential } from "./oauth";

import { discoverKimiCatalog, KIMI_CATALOG_TTL_MS, staticKimiCatalog } from "./catalog";

const credential: KimiCredential = {
  accessToken: "catalog-access-token",
  refreshToken: "catalog-refresh-token",
  expiresAt: Number.MAX_SAFE_INTEGER,
  deviceId: "catalog-device-id",
};

function context(): AccountContext<KimiCredential, Record<string, never>> {
  return {
    credentials: {
      read: async () => ({ value: credential, revision: 1 }),
      refresh: async () => ({ status: "superseded", snapshot: { value: credential, revision: 1 } }),
    },
    options: {},
    signal: new AbortController().signal,
  };
}

test("discovers authenticated Kimi language models and normalizes their preferred protocols", async () => {
  const account = context();
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(input).toBe("https://api.kimi.com/coding/v1/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer catalog-access-token");
    expect(new Headers(init?.headers).get("X-Msh-Device-Id")).toBe("catalog-device-id");
    expect(init?.signal).toBe(account.signal);
    return Response.json({
      data: [
        { id: " kimi-for-coding ", display_name: " Kimi for Coding ", protocol: "openai" },
        { id: "  ", display_name: "Blank", protocol: "anthropic" },
        { id: "k3", display_name: "K3", protocol: "anthropic" },
        { id: "", display_name: "Empty", protocol: null },
        { display_name: "Missing ID", protocol: "future-protocol" },
      ],
    });
  };

  expect(await discoverKimiCatalog(account, { fetch })).toEqual({
    language: [
      {
        id: "kimi-for-coding",
        displayName: "Kimi for Coding",
        metadata: { protocol: "openai-compatible" },
      },
      { id: "k3", displayName: "K3", metadata: { protocol: "anthropic" } },
    ],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  });
});

test("provides a six-hour static first-login fallback", () => {
  expect(KIMI_CATALOG_TTL_MS).toBe(6 * 60 * 60_000);
  expect(staticKimiCatalog().language).toEqual([
    {
      id: "kimi-for-coding",
      displayName: "Kimi for Coding",
      metadata: { protocol: "openai-compatible" },
    },
  ]);
});

test("rejects catalog HTTP failures without exposing credentials or response bodies", async () => {
  const body = "sensitive upstream response";
  const fetch = async (): Promise<Response> => new Response(body, { status: 503 });

  const error = await captureError(fetch);

  expect(error.message).toBe("Kimi model catalog request failed with 503");
  expect(error.message).not.toContain(credential.accessToken);
  expect(error.message).not.toContain(body);
});

test("rejects malformed catalog roots without exposing credentials or response bodies", async () => {
  const body = "sensitive malformed response";
  const fetch = async (): Promise<Response> => Response.json({ data: body });

  const error = await captureError(fetch);

  expect(error.message).toBe("Kimi model catalog response is invalid");
  expect(error.message).not.toContain(credential.accessToken);
  expect(error.message).not.toContain(body);
});

async function captureError(fetch: typeof globalThis.fetch): Promise<Error> {
  try {
    await discoverKimiCatalog(context(), { fetch });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected catalog discovery to fail");
}
