import { describe, expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import { createOpenAIChatGPTDynamicFetch, createOpenAIChatGPTRuntime, currentCredential } from "../src/runtime";
import type { ChatGPTCredential } from "../src/schema";

type FetchCall = {
  readonly body: string;
  readonly headers: Headers;
  readonly signal: AbortSignal | null | undefined;
  readonly url: string;
};

describe("OpenAI ChatGPT runtime", () => {
  test("returns a ProviderV4 without a raw resolver", async () => {
    const runtime = await createOpenAIChatGPTRuntime({
      credentials: staticCredentialPort(credential()),
      options: {},
      catalog: emptyCatalog(),
    });

    expect(runtime.provider.specificationVersion).toBe("v4");
    expect(runtime.provider.languageModel("gpt-5.5")).toBeDefined();
    expect(runtime.raw).toBeUndefined();
  });

  test("routes every concurrent expired request through the host credential refresh port", async () => {
    const calls: FetchCall[] = [];
    let refreshCalls = 0;
    const expired = credential({ accessToken: "expired", expiresAt: Date.now() - 1 });
    const fresh = credential({ accessToken: "fresh", expiresAt: Date.now() + 60_000 });
    const credentials: CredentialPort<ChatGPTCredential> = {
      read: async () => ({ revision: 3, value: expired }),
      refresh: async (revision) => {
        refreshCalls += 1;
        expect(revision).toBe(3);
        return { status: "updated", snapshot: { revision: 4, value: fresh } };
      },
    };
    const dynamicFetch = createOpenAIChatGPTDynamicFetch(credentials, captureFetch(calls));

    await Promise.all([
      dynamicFetch("https://api.openai.com/v1/responses", { method: "POST" }),
      dynamicFetch("https://api.openai.com/v1/responses", { method: "POST" }),
    ]);

    expect(refreshCalls).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.headers.get("authorization") === "Bearer fresh")).toBe(true);
  });

  test("returns refreshed expiry metadata to the host credential port", async () => {
    const originalFetch = globalThis.fetch;
    let metadata: { readonly expiresAt?: number } | undefined;
    const expired = credential({ accessToken: "expired", expiresAt: 0 });
    const credentials: CredentialPort<ChatGPTCredential> = {
      read: async () => ({ revision: 3, value: expired }),
      refresh: async (revision, exchange) => {
        const exchanged = await exchange({ revision, value: expired }, new AbortController().signal);
        metadata = exchanged.metadata;
        return { status: "updated", snapshot: { revision: revision + 1, value: exchanged.value } };
      },
    };
    globalThis.fetch = async () =>
      Response.json({ access_token: buildJwt({ chatgpt_account_id: "acct-refreshed" }), expires_in: 60 });

    try {
      const refreshed = await currentCredential(credentials);
      expect(metadata).toEqual({ expiresAt: refreshed.expiresAt });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("replaces caller auth, injects ChatGPT headers, and rewrites Codex paths", async () => {
    const calls: FetchCall[] = [];
    const dynamicFetch = createOpenAIChatGPTDynamicFetch(
      staticCredentialPort(credential({ accessToken: "runtime-token" })),
      captureFetch(calls),
    );
    const controller = new AbortController();

    const body = JSON.stringify({ input: "hello", model: "gpt-5.5", stream: true });
    await dynamicFetch("https://api.openai.com/v1/responses?foo=bar&foo=baz", {
      body,
      headers: { authorization: "Bearer caller-token", "x-keep": "1" },
      method: "POST",
      signal: controller.signal,
    });
    await dynamicFetch("https://api.openai.com/v1/chat/completions", { method: "POST" });
    await dynamicFetch("https://api.openai.com/v1/models", { method: "GET" });

    const first = requiredCall(calls, 0);
    expect(first.url).toBe("https://chatgpt.com/backend-api/codex/responses?foo=bar&foo=baz");
    expect(requiredCall(calls, 1).url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(requiredCall(calls, 2).url).toBe("https://api.openai.com/v1/models");
    expect(first.headers.get("authorization")).toBe("Bearer runtime-token");
    expect(first.headers.get("ChatGPT-Account-Id")).toBe("acct-123");
    expect(first.headers.get("Originator")).toBe("codex-tui");
    expect(first.headers.get("User-Agent")).toBe(
      "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)",
    );
    expect(first.headers.get("session-id")).toBeString();
    expect(first.headers.get("x-keep")).toBe("1");
    expect(first.body).toBe(body);
    expect(first.signal).toBe(controller.signal);
    expect(requiredCall(calls, 1).headers.get("session-id")).not.toBe(first.headers.get("session-id"));
  });
});

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
  return {
    accessToken: "access-token",
    accountId: "acct-123",
    expiresAt: Date.now() + 60_000,
    refreshToken: "refresh-token",
    ...overrides,
  };
}

function buildJwt(payload: object): string {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}

function staticCredentialPort(value: ChatGPTCredential): CredentialPort<ChatGPTCredential> {
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

function captureFetch(calls: FetchCall[]): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      body: await request.text(),
      headers: new Headers(request.headers),
      signal: init?.signal ?? request.signal,
      url: request.url,
    });
    return new Response("", { status: 200 });
  };
}

function requiredCall(calls: readonly FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`missing fetch call ${index}`);
  return call;
}
