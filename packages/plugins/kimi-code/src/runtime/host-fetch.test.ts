import type { CredentialPort, ModelCatalog } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { KimiCredential } from "../oauth";

import { createKimiRuntime } from "./runtime";

test("routes the final Kimi Code request through the host fetch", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = async () => {
    throw new Error("unexpected global fetch");
  };

  try {
    const runtime = await createKimiRuntime({
      credentials: credentialPort(),
      options: {},
      catalog: catalog(),
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    });
    const transport = runtime.raw?.({ protocol: "openai-compatible", modelId: "kimi-model" });
    if (transport === undefined) throw new Error("missing Kimi Code raw transport");

    await transport.invoke(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kimi-model", messages: [] }),
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request?.url).toBe("https://api.kimi.com/coding/v1/chat/completions");
  expect(request?.headers.get("authorization")).toBe("Bearer access-token");
  expect(request?.headers.get("x-msh-platform")).toBe("AIO-Proxy");
  expect(request?.headers.get("x-msh-device-id")).toBe("device-1");
  expect(request?.headers.get("user-agent")).toContain("AIO-Proxy/");
});

function credentialPort(): CredentialPort<KimiCredential> {
  const value = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: 4_000_000_000_000,
    deviceId: "device-1",
  };
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error("valid credentials must not refresh");
    },
  };
}

function catalog(): ModelCatalog {
  return {
    language: [{ id: "kimi-model", metadata: { protocol: "openai-compatible" } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}
