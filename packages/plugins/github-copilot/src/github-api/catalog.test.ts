import { describe, expect, test } from "bun:test";
import type { ProtocolId } from "@aio-proxy/plugin-sdk";
import { credentialPort, withFetchMock } from "../../_test/test-support";
import { discoverGitHubCopilotModels, type GitHubCopilotCredential } from ".";

describe("GitHub Copilot catalog", () => {
  test("filters hidden or non-chat models and maps supported protocols", async () => {
    const credential: GitHubCopilotCredential = {
      githubToken: "github-token",
      copilotToken: "copilot-token",
      expiresAt: 9_999_999_999_000,
      baseURL: "https://api.individual.githubcopilot.com",
    };
    const credentials = credentialPort(credential);

    const models = await withFetchMock(
      async (_input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer copilot-token");
        expect(headers.get("accept")).toBe("application/json");
        return modelResponse();
      },
      () => discoverGitHubCopilotModels(credentials.port, new AbortController().signal),
    );

    expect(models).toEqual([
      { id: "gpt-5-mini", displayName: "GPT 5 Mini", metadata: { protocol: "openai-compatible" } },
      { id: "claude-sonnet-4", metadata: { protocol: "anthropic" } },
      { id: "gpt-5", metadata: { protocol: "openai-response" } },
    ]);
  });
});

function modelResponse(): Response {
  return Response.json({
    data: [
      {
        id: "gpt-5-mini",
        name: "GPT 5 Mini",
        model_picker_enabled: true,
        capabilities: { type: "chat" },
        supported_endpoints: ["/chat/completions"],
      },
      {
        id: "claude-sonnet-4",
        model_picker_enabled: true,
        capabilities: ["chat"],
        supported_endpoints: ["/v1/messages"],
      },
      {
        id: "gpt-5",
        model_picker_enabled: true,
        capabilities: { type: "chat" },
        supported_endpoints: ["/responses"],
      },
      {
        id: "hidden",
        model_picker_enabled: false,
        capabilities: { type: "chat" },
        supported_endpoints: ["/chat/completions"],
      },
      {
        id: "embedding",
        model_picker_enabled: true,
        capabilities: { type: "embeddings" },
        supported_endpoints: ["/embeddings"],
      },
    ],
  });
}

const _protocolsCompile: readonly ProtocolId[] = ["openai-compatible", "anthropic", "openai-response"];
void _protocolsCompile;
