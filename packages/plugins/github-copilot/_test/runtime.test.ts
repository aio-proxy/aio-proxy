import { describe, expect, test } from "bun:test";
import type { CredentialPort, ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { GitHubAccountOptions, GitHubCopilotCredential } from "../src";
import { createGitHubCopilotRuntime } from "../src/runtime";

describe("GitHub Copilot runtime", () => {
  test("selects language providers from canonical catalog protocol metadata", async () => {
    const credentials = mutableCredentialPort(validCredential("copilot-token"));
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: "github.com" },
      catalog: catalog(),
    });

    expect(runtime.provider.specificationVersion).toBe("v4");
    expect(runtime.provider.languageModel("gpt-chat").provider).toContain("openai-compatible");
    expect(runtime.provider.languageModel("claude").provider).toContain("anthropic");
    expect(runtime.provider.languageModel("gpt-response").provider).toContain("openai");
    expect(() => runtime.provider.languageModel("missing")).toThrow("missing");
  });

  test("dynamic provider fetch refreshes credentials without rebuilding the runtime", async () => {
    const refreshSignal = new AbortController().signal;
    const credentials = mutableCredentialPort(
      {
        githubToken: "github-token",
        copilotToken: "expired-token",
        expiresAt: 0,
        baseURL: "https://stale.example",
      },
      refreshSignal,
    );
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: "github.com" },
      catalog: catalog(),
    });
    const calls: { url: URL; authorization: string | null; signal: AbortSignal | null }[] = [];

    await withFetchMock(
      async (input, init) => {
        const url = new URL(input.toString());
        if (url.pathname === "/copilot_internal/v2/token") {
          calls.push({
            url,
            authorization: new Headers(init?.headers).get("authorization"),
            signal: init?.signal ?? null,
          });
          return Response.json({ token: "refreshed-token", expires_at: 9_999_999_999 });
        }
        calls.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          signal: init?.signal ?? null,
        });
        return Response.json({
          id: "chatcmpl-test",
          created: 1,
          model: "gpt-chat",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
      async () => {
        await runtime.provider.languageModel("gpt-chat").doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        });
      },
    );

    expect(calls[0]?.url.pathname).toBe("/copilot_internal/v2/token");
    expect(calls[0]?.authorization).toBe("Bearer github-token");
    expect(calls[0]?.signal).toBe(refreshSignal);
    expect(calls[1]?.url.toString()).toBe("https://api.githubcopilot.com/chat/completions");
    expect(calls[1]?.authorization).toBe("Bearer refreshed-token");
    expect(credentials.current().value.copilotToken).toBe("refreshed-token");
  });

  test("raw resolver matches model protocol and preserves request details while rewriting origin", async () => {
    const credentials = mutableCredentialPort(validCredential("raw-token"));
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: "github.com" },
      catalog: catalog(),
    });

    expect(runtime.raw?.({ protocol: "anthropic", modelId: "gpt-chat" })).toBeUndefined();
    const transport = runtime.raw?.({ protocol: "openai-compatible", modelId: "gpt-chat" });
    expect(transport).toBeDefined();

    const controller = new AbortController();
    let captured: Request | undefined;
    let capturedSignal: AbortSignal | null | undefined;
    const response = await withFetchMock(
      async (request, init) => {
        capturedSignal = init?.signal;
        captured = new Request(request, init);
        return Response.json({ ok: true });
      },
      () =>
        transport?.invoke(
          new Request("http://localhost/v1/chat/completions?trace=1", {
            method: "POST",
            headers: { "content-type": "application/json", "x-client": "kept" },
            body: JSON.stringify({ model: "gpt-chat", messages: [] }),
            signal: controller.signal,
          }),
        ) as Promise<Response>,
    );

    expect(response.status).toBe(200);
    expect(captured?.url).toBe("https://api.githubcopilot.com/v1/chat/completions?trace=1");
    expect(captured?.method).toBe("POST");
    expect(capturedSignal).toBe(controller.signal);
    expect(captured?.headers.get("x-client")).toBe("kept");
    expect(captured?.headers.get("authorization")).toBe("Bearer raw-token");
    expect(captured?.headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
    expect(await captured?.json()).toEqual({ model: "gpt-chat", messages: [] });
  });
});

function catalog(): ModelCatalog {
  return {
    language: [
      { id: "gpt-chat", metadata: { protocol: "openai-compatible" } },
      { id: "claude", metadata: { protocol: "anthropic" } },
      { id: "gpt-response", metadata: { protocol: "openai-response" } },
    ],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function validCredential(copilotToken: string): GitHubCopilotCredential {
  return {
    githubToken: "github-token",
    copilotToken,
    expiresAt: Date.now() + 60_000,
    baseURL: "https://api.githubcopilot.com",
  };
}

function mutableCredentialPort(initial: GitHubCopilotCredential, refreshSignal = new AbortController().signal) {
  let snapshot = { value: initial, revision: 1 };
  return {
    port: {
      read: async () => snapshot,
      refresh: async (expectedRevision, exchange) => {
        if (expectedRevision !== snapshot.revision) return { status: "superseded" as const, snapshot };
        const refreshed = await exchange(snapshot, refreshSignal);
        snapshot = { value: refreshed.value, revision: snapshot.revision + 1 };
        return { status: "updated" as const, snapshot };
      },
    } satisfies CredentialPort<GitHubCopilotCredential>,
    current: () => snapshot,
  };
}

async function withFetchMock<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const _optionsCompile: GitHubAccountOptions = { deploymentType: "github.com" };
void _optionsCompile;
