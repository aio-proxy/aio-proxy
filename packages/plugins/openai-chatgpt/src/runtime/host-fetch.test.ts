import type { CredentialPort } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { ChatGPTCredential } from "../schema";

test("routes the final ChatGPT request through the host fetch", async () => {
  const originalFetch = globalThis.fetch;
  const clientId = Reflect.get(globalThis, "__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__");
  const requests: Request[] = [];
  Reflect.set(globalThis, "__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__", clientId ?? "test-client-id");
  globalThis.fetch = async () => {
    throw new Error("unexpected global fetch");
  };

  try {
    const { createOpenAIChatGPTRuntime } = await import(".");
    const runtime = await createOpenAIChatGPTRuntime({
      credentials: credentialPort(),
      options: {},
      catalog: emptyCatalog(),
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    });
    const transport = runtime.raw?.({ protocol: "openai-response", modelId: "gpt-5.5" });
    if (transport === undefined) throw new Error("missing ChatGPT raw transport");

    await transport.invoke(
      new Request("http://127.0.0.1:22078/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1:22078" },
        body: JSON.stringify({ model: "gpt-5.5", input: "hello" }),
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal("__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__", clientId);
  }

  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(request?.headers.get("authorization")).toBe("Bearer access-token");
  expect(request?.headers.get("chatgpt-account-id")).toBe("acct-123");
  expect(request?.headers.get("originator")).toBe("codex-tui");
  expect(request?.headers.get("user-agent")).toContain("codex-tui/");
  expect(request?.headers.get("host")).toBeNull();
});

function credentialPort(): CredentialPort<ChatGPTCredential> {
  const value = {
    accessToken: "access-token",
    accountId: "acct-123",
    expiresAt: Date.now() + 60_000,
    refreshToken: "refresh-token",
  };
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error("valid credentials must not refresh");
    },
  };
}

function emptyCatalog() {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}

function restoreGlobal(key: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, key);
  else Reflect.set(globalThis, key, value);
}
