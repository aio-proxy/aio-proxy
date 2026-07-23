import type { ModelCatalog } from "@aio-proxy/plugin-sdk";

import { createToolImageMarker } from "@aio-proxy/plugin-sdk/openai-stream";
import { expect, test } from "bun:test";

import type { GitHubCopilotCredential } from "../github-api";

import { credentialPort, withFetchMock } from "../../_test/test-support";
import { createGitHubCopilotRuntime } from "./runtime";

const toolImagePrompt = [
  {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "inspect", input: {} }],
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "call_1",
        toolName: "inspect",
        output: {
          type: "content" as const,
          value: [
            { type: "text" as const, text: "before" },
            {
              type: "file" as const,
              mediaType: "image/png",
              data: { type: "data" as const, data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "low" },
                aioProxy: createToolImageMarker(),
              },
            },
          ],
        },
      },
    ],
  },
] as const;

test("compatible delegate emits CPA tool image content", async () => {
  const credentials = credentialPort(validCredential());
  const runtime = await createGitHubCopilotRuntime({
    credentials: credentials.port,
    options: { deploymentType: "github.com" },
    catalog: catalog(),
  });
  let captured: Request | undefined;

  await withFetchMock(
    async (input, init) => {
      captured = new Request(input, init);
      return Response.json({
        id: "chatcmpl-test",
        created: 1,
        model: "gpt-chat",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
    () => runtime.provider.languageModel("gpt-chat").doGenerate({ prompt: toolImagePrompt }),
  );

  expect((await captured?.json()) as unknown).toMatchObject({
    messages: [
      expect.objectContaining({ role: "assistant" }),
      {
        role: "tool",
        tool_call_id: "call_1",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "low" } },
        ],
      },
    ],
  });
});

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

function validCredential(): GitHubCopilotCredential {
  return {
    githubToken: "github-token",
    copilotToken: "copilot-token",
    expiresAt: Date.now() + 60_000,
    baseURL: "https://api.githubcopilot.com",
  };
}
