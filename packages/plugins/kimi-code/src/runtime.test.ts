import { describe, expect, test } from "bun:test";
import type { CredentialPort, ModelCatalog } from "@aio-proxy/plugin-sdk";
import type { KimiCredential } from "./oauth";
import { createKimiDynamicFetch, createKimiRuntime } from "./runtime";

describe("Kimi Code runtime", () => {
  test("selects converted language providers from catalog metadata", async () => {
    const runtime = await createKimiRuntime(context(validCredential(), catalog()));

    expect(runtime.provider.specificationVersion).toBe("v4");
    expect(runtime.provider.languageModel("openai-model").provider).toContain("openai-compatible");
    expect(runtime.provider.languageModel("anthropic-model").provider).toContain("anthropic");
    expect(() => runtime.provider.languageModel("missing")).toThrow("missing");
  });

  for (const scenario of [
    {
      modelId: "openai-model",
      url: "https://api.kimi.com/coding/v1/chat/completions",
      response: {
        id: "chatcmpl-test",
        created: 1,
        model: "openai-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    },
    {
      modelId: "anthropic-model",
      url: "https://api.kimi.com/coding/v1/messages",
      response: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "anthropic-model",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ] as const) {
    test(`${scenario.modelId} generation uses the Kimi endpoint and current identity`, async () => {
      const calls: Request[] = [];
      const signals: (AbortSignal | null | undefined)[] = [];
      const runtime = await createKimiRuntime(context(validCredential("current-token"), catalog()), {
        fetch: async (input, init) => {
          calls.push(new Request(input, init));
          signals.push(init?.signal);
          return Response.json(scenario.response);
        },
      });
      const controller = new AbortController();

      await runtime.provider.languageModel(scenario.modelId).doGenerate({
        prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        abortSignal: controller.signal,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(scenario.url);
      expect(calls[0]?.method).toBe("POST");
      expect(signals[0]).toBe(controller.signal);
      expect(calls[0]?.headers.get("authorization")).toBe("Bearer current-token");
      expect(calls[0]?.headers.get("x-msh-device-id")).toBe("device-1");
      expect(calls[0]?.headers.get("x-api-key")).toBeNull();
      expect(calls[0]?.headers.get("anthropic-api-key")).toBeNull();
      expect(JSON.stringify([...(calls[0]?.headers ?? new Headers())])).not.toContain("dynamic-credential");
    });
  }

  test("offers both raw protocols for every catalog language model", async () => {
    const runtime = await createKimiRuntime(context(validCredential(), catalog()));

    for (const modelId of ["openai-model", "anthropic-model", "raw-only-model"]) {
      expect(runtime.raw?.({ protocol: "openai-compatible", modelId })).toBeDefined();
      expect(runtime.raw?.({ protocol: "anthropic", modelId })).toBeDefined();
    }
    expect(runtime.raw?.({ protocol: "gemini", modelId: "openai-model" })).toBeUndefined();
    expect(runtime.raw?.({ protocol: "anthropic", modelId: "missing" })).toBeUndefined();
  });

  for (const scenario of [
    { protocol: "openai-compatible", path: "/v1/chat/completions" },
    { protocol: "anthropic", path: "/v1/messages" },
  ] as const) {
    test(`${scenario.protocol} raw transport allowlists its path and preserves request details`, async () => {
      let captured: Request | undefined;
      let signal: AbortSignal | null | undefined;
      const runtime = await createKimiRuntime(context(validCredential("raw-token"), catalog()), {
        fetch: async (input, init) => {
          captured = new Request(input, init);
          signal = init?.signal;
          return Response.json({ ok: true });
        },
      });
      const transport = runtime.raw?.({ protocol: scenario.protocol, modelId: "openai-model" });
      const controller = new AbortController();
      const request = new Request(`https://untrusted.example${scenario.path}?trace=1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-client": "kept",
          host: "attacker.example",
          cookie: "session=client-secret",
          "proxy-authorization": "Basic client-secret",
          authorization: "Bearer client-secret",
          "x-api-key": "placeholder-secret",
          "x-goog-api-key": "placeholder-secret",
          "anthropic-api-key": "placeholder-secret",
        },
        body: JSON.stringify({ model: "client-model", marker: "kept" }),
        signal: controller.signal,
        redirect: "manual",
      });

      await transport?.invoke(request);

      expect(captured?.url).toBe(`https://api.kimi.com/coding${scenario.path}?trace=1`);
      expect(captured?.method).toBe("POST");
      expect(captured?.redirect).toBe("manual");
      expect(signal).toBe(controller.signal);
      expect(captured?.headers.get("x-client")).toBe("kept");
      expect(captured?.headers.get("authorization")).toBe("Bearer raw-token");
      for (const name of "host cookie proxy-authorization x-api-key x-goog-api-key anthropic-api-key".split(" ")) {
        expect(captured?.headers.get(name)).toBeNull();
      }
      expect(await captured?.json()).toEqual({ model: "client-model", marker: "kept" });
    });
  }

  test("rejects non-allowlisted raw paths before fetch without exposing the inbound host", async () => {
    let calls = 0;
    const runtime = await createKimiRuntime(context(validCredential(), catalog()), {
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    const transport = runtime.raw?.({ protocol: "anthropic", modelId: "openai-model" });
    const request = new Request("https://secret-host.example/v1/messages/client-secret-path", {
      method: "POST",
      body: "client-secret-body",
    });

    const error = await transport?.invoke(request).catch(String);
    expect(error).toBe("Error: Unsupported Kimi raw path");
    expect(calls).toBe(0);
  });

  test("counts Anthropic input tokens natively with the resolved model", async () => {
    let captured: Request | undefined;
    let signal: AbortSignal | null | undefined;
    const runtime = await createKimiRuntime(context(validCredential("count-token"), catalog()), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        signal = init?.signal;
        return Response.json({ input_tokens: 17 });
      },
    });
    const controller = new AbortController();

    const result = await runtime.tokenCount?.countTokens({
      protocol: "anthropic",
      modelId: "resolved-model",
      request: new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST",
        headers: { "content-type": "application/json", "x-client": "kept", "x-api-key": "client-secret" },
        body: JSON.stringify({ model: "client-model", messages: [] }),
        signal: controller.signal,
      }),
      context: logicalContext(),
      invocation: { messages: [] },
    });

    expect(result).toEqual({ inputTokens: 17 });
    expect(captured?.url).toBe("https://api.kimi.com/coding/v1/messages/count_tokens?beta=true");
    expect(signal).toBe(controller.signal);
    expect(captured?.headers.get("x-client")).toBe("kept");
    expect(captured?.headers.get("authorization")).toBe("Bearer count-token");
    expect(captured?.headers.get("x-api-key")).toBeNull();
    expect(await captured?.json()).toEqual({ model: "resolved-model", messages: [] });
  });

  test("rejects unsupported token-count protocols and invalid upstream counts", async () => {
    let response: unknown = { input_tokens: -1 };
    let calls = 0;
    const runtime = await createKimiRuntime(context(validCredential(), catalog()), {
      fetch: async () => {
        calls += 1;
        return Response.json(response);
      },
    });
    await expect(runtime.tokenCount?.countTokens(tokenCountInput("openai-compatible"))).rejects.toThrow(
      "does not support openai-compatible",
    );
    expect(calls).toBe(0);
    for (response of [{ input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }, {}]) {
      await expect(runtime.tokenCount?.countTokens(tokenCountInput("anthropic"))).rejects.toThrow(
        "response is invalid",
      );
    }
  });

  test("dynamic fetch refreshes credentials and never forwards client credentials", async () => {
    const credentials = credentialPort({ ...validCredential("expired-token"), expiresAt: 0 });
    const calls: Request[] = [];
    const fetcher = createKimiDynamicFetch(credentials, {
      now: () => 1_000,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        if (request.url.includes("/oauth/token")) {
          return Response.json({ access_token: "refreshed-token", refresh_token: "new-refresh", expires_in: 3600 });
        }
        return Response.json({ ok: true });
      },
    });

    await fetcher("https://api.kimi.com/coding/v1/messages", {
      method: "POST",
      headers: {
        authorization: "Bearer client-secret",
        "x-api-key": "placeholder",
        "anthropic-api-key": "placeholder",
      },
      body: "{}",
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get("authorization")).toBe("Bearer refreshed-token");
    expect(calls[1]?.headers.get("x-api-key")).toBeNull();
    expect(calls[1]?.headers.get("anthropic-api-key")).toBeNull();
    expect(credentials.current().accessToken).toBe("refreshed-token");
  });
});

function validCredential(accessToken = "access-token"): KimiCredential {
  return { accessToken, refreshToken: "refresh-token", expiresAt: 4_000_000_000_000, deviceId: "device-1" };
}

function credentialPort(initial: KimiCredential) {
  let value = initial;
  const port: CredentialPort<KimiCredential> = {
    read: async () => ({ value, revision: 1 }),
    refresh: async (_revision, exchange) => {
      const next = await exchange({ value, revision: 1 }, new AbortController().signal);
      value = next.value;
      return { status: "updated", snapshot: { value, revision: 2 } };
    },
  };
  return Object.assign(port, { current: () => value });
}

function catalog(): ModelCatalog {
  return {
    language: [
      { id: "openai-model", metadata: { protocol: "openai-compatible" } },
      { id: "anthropic-model", metadata: { protocol: "anthropic" } },
      { id: "raw-only-model" },
    ],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function context(credential: KimiCredential, modelCatalog: ModelCatalog) {
  return { credentials: credentialPort(credential), options: {}, catalog: modelCatalog };
}

function logicalContext() {
  return { requestId: "request-1", session: { key: "sha256:test" as const, source: "transcript" as const } };
}

function tokenCountInput(protocol: "anthropic" | "openai-compatible") {
  return {
    protocol,
    modelId: "resolved-model",
    request: new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "client-model", messages: [] }),
    }),
    context: logicalContext(),
    invocation: { messages: [] },
  };
}
