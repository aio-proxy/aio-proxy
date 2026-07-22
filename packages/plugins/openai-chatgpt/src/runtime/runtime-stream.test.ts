import type { CredentialPort } from "@aio-proxy/plugin-sdk";

import { describe, expect, test } from "bun:test";

import type { ChatGPTCredential } from "../schema";

import { createOpenAIChatGPTDynamicFetch } from ".";

const RESPONSES_TERMINAL =
  'data: {"type":"response.completed","response":{"incomplete_details":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';

describe("OpenAI ChatGPT runtime stream protection", () => {
  test("model path finishes a zstd terminal without a late decode error", async () => {
    const { fetch, secondPulls, cancelled } = terminalThenErrorUpstream(RESPONSES_TERMINAL);
    const dynamicFetch = createOpenAIChatGPTDynamicFetch(staticCredentialPort(credential()), fetch);
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openAI = createOpenAI({
      name: "openai-chatgpt",
      baseURL: "https://chatgpt.com/backend-api/codex",
      apiKey: "dynamic-credential",
      fetch: dynamicFetch,
    });

    const result = await openAI.languageModel("gpt-5.5").doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    const parts = await Array.fromAsync(result.stream);

    expect(parts.some((part) => part.type === "finish")).toBe(true);
    expect(parts.some((part) => part.type === "error")).toBe(false);
    expect(secondPulls()).toBe(0);
    expect(cancelled()).toBe(true);
  });

  test("raw path rewrites auth and closes at compressed terminal", async () => {
    let acceptEncoding: string | null = null;
    let decompress: boolean | undefined;
    let pulls = 0;
    let wasCancelled = false;
    const plain = new TextEncoder().encode(RESPONSES_TERMINAL);
    const body = Bun.zstdCompressSync(plain);

    const upstreamFetch = (async (input, init) => {
      const request = new Request(input, init);
      acceptEncoding = request.headers.get("accept-encoding");
      decompress = (init as { decompress?: boolean } | undefined)?.decompress;
      expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses?stream=true");
      expect(request.headers.get("authorization")).toBe("Bearer runtime-token");
      expect(request.headers.get("ChatGPT-Account-Id")).toBe("acct-123");
      expect(request.headers.get("Originator")).toBe("codex-tui");
      expect(request.headers.get("session-id")).toBeString();
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(body);
                return;
              }
              controller.error(new TypeError("error decoding response body"));
            },
            cancel() {
              wasCancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            "content-type": "text/event-stream",
            "content-encoding": "zstd",
            "content-length": String(body.byteLength),
          },
        },
      );
    }) as typeof globalThis.fetch;

    const dynamicFetch = createOpenAIChatGPTDynamicFetch(
      staticCredentialPort(credential({ accessToken: "runtime-token" })),
      upstreamFetch,
    );
    const raw = { invoke: (request: Request) => dynamicFetch(request) };

    const response = await raw.invoke(new Request("https://api.openai.com/v1/responses?stream=true"));
    expect(decompress).toBe(false);
    expect(acceptEncoding).toBe("gzip, deflate, br, zstd");
    expect(await response.text()).toBe(RESPONSES_TERMINAL);
    expect(Math.max(0, pulls - 1)).toBe(0);
    expect(wasCancelled).toBe(true);
  });
});

function terminalThenErrorUpstream(terminal: string) {
  const plain = new TextEncoder().encode(terminal);
  const body = Bun.zstdCompressSync(plain);
  let pulls = 0;
  let wasCancelled = false;

  const fetch = (async () => {
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(body);
              return;
            }
            controller.error(new TypeError("error decoding response body"));
          },
          cancel() {
            wasCancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
      {
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "zstd",
        },
      },
    );
  }) as typeof globalThis.fetch;

  return {
    fetch,
    secondPulls: () => Math.max(0, pulls - 1),
    cancelled: () => wasCancelled,
  };
}

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
  return {
    accessToken: "access-token",
    accountId: "acct-123",
    expiresAt: Date.now() + 60_000,
    refreshToken: "refresh-token",
    ...overrides,
  };
}

function staticCredentialPort(value: ChatGPTCredential): CredentialPort<ChatGPTCredential> {
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error("valid credentials must not refresh");
    },
  };
}
