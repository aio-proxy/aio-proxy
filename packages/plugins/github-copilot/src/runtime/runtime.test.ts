import type { ModelCatalog } from "@aio-proxy/plugin-sdk";

import { describe, expect, test } from "bun:test";

import type { GitHubAccountOptions, GitHubCopilotCredential } from "..";

import { credentialPort, withFetchMock } from "../../_test/test-support";
import { createGitHubCopilotRuntime } from "./runtime";

describe("GitHub Copilot runtime", () => {
  test("selects language providers from canonical catalog protocol metadata", async () => {
    const credentials = credentialPort(validCredential("copilot-token"));
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
    const credentials = credentialPort(
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
      fetch: forwardFetch,
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

  for (const scenario of [
    {
      name: "Anthropic Messages",
      modelId: "claude",
      token: "anthropic-current-token",
      expectedUrl: "https://api.githubcopilot.com/v1/messages",
      assertBody(body: Record<string, unknown>) {
        expect(body.model).toBe("claude");
        expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
      },
      response: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    {
      name: "OpenAI Responses",
      modelId: "gpt-response",
      token: "responses-current-token",
      expectedUrl: "https://api.githubcopilot.com/responses",
      assertBody(body: Record<string, unknown>) {
        expect(body.model).toBe("gpt-response");
        expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
      },
      response: {
        id: "resp_test",
        object: "response",
        created_at: 1,
        status: "completed",
        error: null,
        incomplete_details: null,
        instructions: null,
        max_output_tokens: null,
        model: "gpt-response",
        output: [
          {
            id: "msg_test",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "ok", annotations: [], logprobs: [] }],
          },
        ],
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: null, summary: null },
        store: false,
        temperature: 1,
        text: { format: { type: "text" }, verbosity: "medium" },
        tool_choice: "auto",
        tools: [],
        top_p: 1,
        truncation: "disabled",
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
        user: null,
        metadata: {},
      },
    },
  ] as const) {
    test(`${scenario.name} doGenerate uses the current Copilot credential and protocol request shape`, async () => {
      const credentials = credentialPort(validCredential(scenario.token));
      const runtime = await createGitHubCopilotRuntime({
        credentials: credentials.port,
        options: { deploymentType: "github.com" },
        catalog: catalog(),
        fetch: forwardFetch,
      });
      const controller = new AbortController();
      let captured: Request | undefined;
      let capturedSignal: AbortSignal | null | undefined;

      await withFetchMock(
        async (input, init) => {
          capturedSignal = init?.signal;
          captured = new Request(input, init);
          return Response.json(scenario.response);
        },
        () =>
          runtime.provider.languageModel(scenario.modelId).doGenerate({
            prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
            abortSignal: controller.signal,
          }),
      );

      expect(captured?.url).toBe(scenario.expectedUrl);
      expect(capturedSignal).toBe(controller.signal);
      expect(captured?.method).toBe("POST");
      expect(captured?.headers.get("authorization")).toBe(`Bearer ${scenario.token}`);
      expect(captured?.headers.get("x-api-key")).toBeNull();
      expect(JSON.stringify([...(captured?.headers ?? new Headers()).entries()])).not.toContain("dynamic-credential");
      scenario.assertBody((await captured?.json()) as Record<string, unknown>);
    });
  }

  test("raw resolver matches model protocol and preserves request details while rewriting origin", async () => {
    const credentials = credentialPort(validCredential("raw-token"));
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: "github.com" },
      catalog: catalog(),
      fetch: forwardFetch,
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

const _optionsCompile: GitHubAccountOptions = { deploymentType: "github.com" };
void _optionsCompile;

const forwardFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
