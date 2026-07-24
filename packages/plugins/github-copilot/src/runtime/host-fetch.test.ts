import type { CredentialPort, ModelCatalog } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { GitHubCopilotCredential } from "../github-api";

import { credentialPort as createCredentialPort } from "../../_test/test-support";

test("routes the final GitHub Copilot request through the host fetch", async () => {
  const originalFetch = globalThis.fetch;
  const clientId = Reflect.get(globalThis, "__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__");
  const requests: Request[] = [];
  Reflect.set(globalThis, "__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__", clientId ?? "test-client-id");
  globalThis.fetch = async () => {
    throw new Error("unexpected global fetch");
  };

  try {
    const { createGitHubCopilotRuntime } = await import("./runtime");
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentialPort(),
      options: { deploymentType: "github.com" },
      catalog: catalog(),
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ ok: true });
      },
    });
    const transport = runtime.raw?.({ protocol: "openai-compatible", modelId: "gpt-chat" });
    if (transport === undefined) throw new Error("missing GitHub Copilot raw transport");

    await transport.invoke(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-chat", messages: [] }),
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal("__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__", clientId);
  }

  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request?.url).toBe("https://api.githubcopilot.com/v1/chat/completions");
  expect(request?.headers.get("authorization")).toBe("Bearer copilot-token");
  expect(request?.headers.get("copilot-integration-id")).toBe("vscode-chat");
  expect(request?.headers.get("editor-plugin-version")).toBe("copilot-chat/0.35.0");
  expect(request?.headers.get("editor-version")).toBe("vscode/1.107.0");
  expect(request?.headers.get("user-agent")).toBe("GitHubCopilotChat/0.35.0");
});

test("routes an expired credential refresh and final request through the host fetch", async () => {
  const originalFetch = globalThis.fetch;
  const clientId = Reflect.get(globalThis, "__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__");
  const urls: string[] = [];
  Reflect.set(globalThis, "__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__", clientId ?? "test-client-id");
  globalThis.fetch = async () => {
    throw new Error("unexpected global fetch");
  };

  try {
    const { createGitHubCopilotRuntime } = await import("./runtime");
    const credentials = createCredentialPort({
      githubToken: "github-token",
      copilotToken: "expired-copilot-token",
      expiresAt: 0,
      baseURL: "https://stale.example",
    });
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: "github.com" },
      catalog: catalog(),
      fetch: async (input, init) => {
        const request = new Request(input, init);
        urls.push(request.url);
        if (request.url === "https://api.github.com/copilot_internal/v2/token") {
          expect(request.headers.get("authorization")).toBe("Bearer github-token");
          return Response.json({ token: "refreshed-copilot-token", expires_at: 9_999_999_999 });
        }
        expect(request.headers.get("authorization")).toBe("Bearer refreshed-copilot-token");
        return Response.json({ ok: true });
      },
    });
    const transport = runtime.raw?.({ protocol: "openai-compatible", modelId: "gpt-chat" });
    if (transport === undefined) throw new Error("missing GitHub Copilot raw transport");

    const response = await transport.invoke(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-chat", messages: [] }),
      }),
    );

    expect(await response.json()).toEqual({ ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal("__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__", clientId);
  }

  expect(urls).toEqual([
    "https://api.github.com/copilot_internal/v2/token",
    "https://api.githubcopilot.com/v1/chat/completions",
  ]);
});

function credentialPort(): CredentialPort<GitHubCopilotCredential> {
  const value = {
    githubToken: "github-token",
    copilotToken: "copilot-token",
    expiresAt: Date.now() + 60_000,
    baseURL: "https://api.githubcopilot.com",
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
    language: [{ id: "gpt-chat", metadata: { protocol: "openai-compatible" } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function restoreGlobal(key: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, key);
  else Reflect.set(globalThis, key, value);
}
