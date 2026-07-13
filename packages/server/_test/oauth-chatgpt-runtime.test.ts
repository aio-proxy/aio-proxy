import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router } from "@aio-proxy/core";
import { Auth, OPENAI_CHATGPT_MODELS } from "@aio-proxy/oauth";
import type { AliasConfig, OAuthProvider } from "@aio-proxy/types";
import { OAuthVendor, ProviderKind } from "@aio-proxy/types";
import { z } from "zod";
import { codexFetchWrapper, createOpenAIChatGPTRuntimeProvider } from "../src/oauth-runtime";

const models = [{ id: "gpt-5.5" }] as const;
const responseBodySchema = z
  .object({
    input: z.string(),
    model: z.string(),
    stream: z.boolean(),
  })
  .loose();

type FetchCall = {
  readonly body?: BodyInit | null;
  readonly headers: Headers;
  readonly url: string;
};

describe("OpenAI ChatGPT OAuth runtime wrapper", () => {
  let dir: string;
  let previousHome: string | undefined;
  const providerIds: string[] = [];

  beforeEach(() => {
    previousHome = process.env.AIO_PROXY_HOME;
    dir = mkdtempSync(join(tmpdir(), "aio-proxy-chatgpt-runtime-"));
    process.env.AIO_PROXY_HOME = dir;
  });

  afterEach(() => {
    for (const providerId of providerIds.splice(0)) {
      Auth.del("openai-chatgpt", providerId);
    }
    if (previousHome === undefined) {
      delete process.env.AIO_PROXY_HOME;
    } else {
      process.env.AIO_PROXY_HOME = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("wrapper injects auth headers and rewrites URL", async () => {
    // Given
    const providerId = trackProvider("chatgpt-header-rewrite");
    const calls: FetchCall[] = [];
    const wrapper = codexFetchWrapper({
      endpoint: "https://chatgpt.com/backend-api/codex/responses",
      fetch: captureFetch(calls, 200),
      getPayload: () => payload({ access: "runtime-token" }),
      providerId,
    });

    // When
    await wrapper("https://example.test/v1/responses", {
      body: "{}",
      headers: { authorization: "Bearer caller-token", "x-keep": "1" },
      method: "POST",
    });
    await wrapper("https://example.test/chat/completions", { method: "POST" });
    await wrapper("https://example.test/v1/models", { method: "GET" });

    // Then
    const first = requiredCall(calls, 0);
    expect(first.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(requiredCall(calls, 1).url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(requiredCall(calls, 2).url).toBe("https://example.test/v1/models");
    expect(first.headers.get("authorization")).toBe("Bearer runtime-token");
    expect(first.headers.get("ChatGPT-Account-Id")).toBe("acct-123");
    expect(first.headers.get("Originator")).toBe("codex-tui");
    expect(first.headers.get("User-Agent")).toBe(
      "codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)",
    );
    expect(first.headers.get("session-id")).toBeString();
    expect(first.headers.get("x-keep")).toBe("1");
  });

  test("wrapper deduplicates concurrent refresh per instance", async () => {
    // Given
    const providerId = trackProvider("chatgpt-refresh-singleflight");
    Auth.set("openai-chatgpt", providerId, payload({ access: "expired-token", expires: Date.now() - 1 }), providerId);
    let releaseRefresh: (() => void) | undefined;
    let refreshCalls = 0;
    const wrapper = codexFetchWrapper({
      fetch: captureFetch([], 200),
      providerId,
      refresh: async () => {
        refreshCalls += 1;
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        return {
          access: "fresh-token",
          accountId: "acct-123",
          expires: Date.now() + 60_000,
          refresh: "refresh-token",
        };
      },
    });

    // When
    const first = wrapper("https://example.test/v1/responses", { method: "POST" });
    const second = wrapper("https://example.test/v1/responses", { method: "POST" });

    // Then
    expect(refreshCalls).toBe(1);
    if (releaseRefresh === undefined) {
      throw new Error("refresh did not start");
    }
    releaseRefresh();
    await Promise.all([first, second]);
    expect(refreshCalls).toBe(1);
  });

  test("wrapper preserves accountFingerprint across refresh writes", async () => {
    // Given
    const providerId = trackProvider("chatgpt-fingerprint");
    Auth.set("openai-chatgpt", providerId, payload({ expires: Date.now() - 1 }), providerId);
    const wrapper = codexFetchWrapper({
      fetch: captureFetch([], 200),
      providerId,
      refresh: async () => ({
        access: "fresh-token",
        accountId: "acct-123",
        expires: Date.now() + 60_000,
        refresh: "refresh-token",
      }),
    });

    // When
    await wrapper("https://example.test/v1/responses", { method: "POST" });

    // Then
    expect(Auth.get("openai-chatgpt", providerId)?.accountFingerprint).toBe(providerId);
    expect(Auth.get("openai-chatgpt", providerId)?.payload).toMatchObject({
      access: "fresh-token",
      models: OPENAI_CHATGPT_MODELS,
    });
  });

  test("wrapper sends Responses-API body shape", async () => {
    // Given
    const providerId = trackProvider("chatgpt-responses-body");
    const calls: FetchCall[] = [];
    const wrapper = codexFetchWrapper({
      fetch: captureFetch(calls, 200),
      getPayload: () => payload({}),
      providerId,
    });
    const body = JSON.stringify({ input: "ping", model: "gpt-5.5", stream: true });

    // When
    await wrapper("https://example.test/v1/responses", { body, method: "POST" });

    // Then
    expect(responseBodySchema.parse(JSON.parse(String(requiredCall(calls, 0).body)))).toEqual({
      input: "ping",
      model: "gpt-5.5",
      stream: true,
    });
  });

  test("wrapper propagates upstream 401", async () => {
    // Given
    const providerId = trackProvider("chatgpt-401");
    const wrapper = codexFetchWrapper({
      fetch: captureFetch([], 401),
      getPayload: () => payload({}),
      providerId,
    });

    // When
    const response = await wrapper("https://example.test/v1/responses", { method: "POST" });

    // Then
    expect(response.status).toBe(401);
  });

  test("bare config auto-exposes a route for every vendor model", () => {
    // Given
    const instance = createOpenAIChatGPTRuntimeProvider(chatgptConfig());

    // Then
    expect(instance.models).toEqual(OPENAI_CHATGPT_MODELS.map((model) => model.id));
    expect(instance.modelMetadata?.["gpt-5.4-mini"]).toEqual({ displayName: "GPT-5.4 mini" });
    const router = new Router([instance]);
    for (const model of OPENAI_CHATGPT_MODELS) {
      expect(instance.alias?.[model.id]).toEqual({ model: model.id, preserve: false });
      expect(router.resolve(model.id)[0]?.modelId).toBe(model.id);
    }
  });

  test("config alias rename replaces the auto self-alias for the targeted model", () => {
    // Given
    const instance = createOpenAIChatGPTRuntimeProvider(chatgptConfig({ gpt5: { model: "gpt-5.5", preserve: false } }));

    // Then
    const router = new Router([instance]);
    expect(router.resolve("gpt5")[0]?.modelId).toBe("gpt-5.5");
    expect(() => router.resolve("gpt-5.5")).toThrow();
  });

  test("refresh writes the static vendor model list, not the payload copy", async () => {
    // Given
    const providerId = trackProvider("chatgpt-refresh-static-models");
    Auth.set("openai-chatgpt", providerId, payload({ expires: Date.now() - 1 }), providerId);
    const wrapper = codexFetchWrapper({
      fetch: captureFetch([], 200),
      providerId,
      refresh: async () => ({
        access: "fresh-token",
        accountId: "acct-123",
        expires: Date.now() + 60_000,
        refresh: "refresh-token",
      }),
    });

    // When
    await wrapper("https://example.test/v1/responses", { method: "POST" });

    // Then
    expect(Auth.get("openai-chatgpt", providerId)?.payload).toMatchObject({ models: OPENAI_CHATGPT_MODELS });
  });

  test("wrapper rejects with login-required when payload is missing models", async () => {
    // Given
    const providerId = trackProvider("chatgpt-missing-models");
    const wrapper = codexFetchWrapper({
      fetch: captureFetch([], 200),
      getPayload: () => ({ access: "a", accountId: "acct-123", expires: Date.now() + 60_000, refresh: "r" }),
      providerId,
    });

    // When / Then
    await expect(wrapper("https://example.test/v1/responses", { method: "POST" })).rejects.toThrow(
      "ChatGPT login required",
    );
  });

  function trackProvider(providerId: string): string {
    providerIds.push(providerId);
    return providerId;
  }
});

function payload(overrides: Partial<ReturnType<typeof payloadBase>>): ReturnType<typeof payloadBase> {
  return { ...payloadBase(), ...overrides };
}

function chatgptConfig(alias?: Readonly<Record<string, AliasConfig>>): OAuthProvider {
  return {
    enabled: true,
    id: "chatgpt-test",
    kind: ProviderKind.OAuth,
    vendor: OAuthVendor.OpenAIChatGPT,
    ...(alias === undefined ? {} : { alias }),
  };
}

function payloadBase() {
  return {
    access: "access-token",
    accountId: "acct-123",
    expires: Date.now() + 60_000,
    models,
    refresh: "refresh-token",
  };
}

function captureFetch(calls: FetchCall[], status: number) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      body: init?.body,
      headers: new Headers(init?.headers),
      url: input instanceof Request ? input.url : input.toString(),
    });
    return new Response("", { status });
  };
}

function requiredCall(calls: readonly FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (call === undefined) {
    throw new Error(`missing fetch call ${index}`);
  }
  return call;
}
