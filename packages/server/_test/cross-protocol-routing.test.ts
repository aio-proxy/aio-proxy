import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiProviderInstance, TextStreamPart, ToolSet } from "@aio-proxy/core";
import { openDb, requestLog } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import type { RuntimeProviderInstance } from "../src/runtime";

const protocols = [
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
] as const;

const inboundCases = [
  {
    protocol: ProviderProtocol.OpenAICompatible,
    path: "/v1/chat/completions",
    body: { model: "m", messages: [{ role: "user", content: "hello" }] },
  },
  {
    protocol: ProviderProtocol.OpenAIResponse,
    path: "/v1/responses",
    body: { model: "m", input: "hello" },
  },
  {
    protocol: ProviderProtocol.Anthropic,
    path: "/v1/messages",
    body: { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hello" }] },
  },
  {
    protocol: ProviderProtocol.Gemini,
    path: "/v1beta/models/m:generateContent",
    body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  },
] as const;

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

describe("cross-protocol HTTP routing", () => {
  test.each([
    [ProviderProtocol.Gemini, "same protocol", "raw"],
    [ProviderProtocol.OpenAIResponse, "cross protocol", "model"],
    [ProviderProtocol.OpenAICompatible, "cross protocol", "model"],
    [ProviderProtocol.Anthropic, "cross protocol", "model"],
    [ProviderProtocol.Gemini, "raw unavailable", "model"],
  ] as const)("routes Antigravity %s %s through %s", async (protocol, condition, expectedCapability) => {
    expect(await runAntigravityMatrixCase(protocol, condition)).toBe(expectedCapability);
  });

  for (const inbound of inboundCases) {
    for (const providerProtocol of protocols) {
      test(`${inbound.protocol} inbound uses ${providerProtocol} raw only when protocols match`, async () => {
        const fixture = provider(providerProtocol, "only");
        const response = await request(inbound, [fixture.value]);

        expect(response.status).toBe(200);
        expect(fixture.calls).toEqual({
          model: inbound.protocol === providerProtocol ? 0 : 1,
          raw: inbound.protocol === providerProtocol ? 1 : 0,
        });
        if (inbound.protocol !== providerProtocol) {
          expectModelResponse(inbound.protocol, await response.json(), `model:${providerProtocol}`);
        }
      });
    }
  }

  test("falls back from model preflight failure to matching raw and stops", async () => {
    const first = provider(ProviderProtocol.Anthropic, "first", {
      model: () => new ReadableStream({ start: (controller) => controller.error(new Error("model unavailable")) }),
    });
    const second = provider(ProviderProtocol.OpenAICompatible, "second");
    const third = provider(ProviderProtocol.OpenAICompatible, "third");
    const home = tempHome();
    const response = await request(inboundCases[0], [first.value, second.value, third.value], home);

    expect(await response.text()).toBe(`raw:${ProviderProtocol.OpenAICompatible}`);
    expect(first.calls).toEqual({ model: 1, raw: 0 });
    expect(second.calls).toEqual({ model: 0, raw: 1 });
    expect(third.calls).toEqual({ model: 0, raw: 0 });
    expect(await recordedAttempts(home)).toEqual([
      expect.objectContaining({ outcome: "failure", providerId: "first" }),
      expect.objectContaining({ outcome: "success", providerId: "second" }),
    ]);
  });
});

type InboundCase = (typeof inboundCases)[number];
type Calls = { model: number; raw: number };

async function runAntigravityMatrixCase(
  protocol: ProviderProtocol,
  condition: "same protocol" | "cross protocol" | "raw unavailable",
): Promise<"model" | "raw"> {
  const inbound = inboundCases.find((candidate) => candidate.protocol === protocol);
  if (inbound === undefined) throw new Error(`Missing inbound fixture for ${protocol}`);
  const fixture = antigravityProvider(condition !== "raw unavailable");
  const response = await request(inbound, [fixture.value]);

  expect(response.status).toBe(200);
  if (fixture.calls.raw === 1) {
    expect(await response.text()).toBe("raw:antigravity");
    return "raw";
  }
  expectModelResponse(protocol, await response.json(), "model:antigravity");
  return "model";
}

function antigravityProvider(rawAvailable: boolean): {
  readonly calls: Calls;
  readonly value: RuntimeProviderInstance;
} {
  const calls: Calls = { model: 0, raw: 0 };
  const value = {
    alias: { m: { model: "m", preserve: false } },
    capability: "default",
    enabled: true,
    id: "antigravity",
    kind: ProviderKind.OAuth,
    model: {
      invoke() {
        calls.model += 1;
        return modelStream("model:antigravity");
      },
    },
    models: ["m"],
    plugin: "@aio-proxy/plugin-google-antigravity",
    raw: {
      resolve: ({ protocol }: { readonly protocol: ProviderProtocol }) =>
        rawAvailable && protocol === ProviderProtocol.Gemini
          ? {
              invoke: async () => {
                calls.raw += 1;
                return new Response("raw:antigravity");
              },
            }
          : undefined,
    },
  } satisfies RuntimeProviderInstance;
  return { calls, value };
}

function provider(
  protocol: ProviderProtocol,
  id: string,
  options: { readonly model?: () => ReadableStream<TextStreamPart<ToolSet>> } = {},
): { readonly calls: Calls; readonly value: RuntimeProviderInstance } {
  const calls: Calls = { model: 0, raw: 0 };
  const raw = async () => {
    calls.raw += 1;
    return new Response(`raw:${protocol}`);
  };
  const invoke = () => {
    calls.model += 1;
    return options.model?.() ?? modelStream(`model:${protocol}`);
  };
  const value = {
    alias: { m: { model: "m", preserve: false } },
    baseURL: `https://${id}.example.test`,
    enabled: true,
    id,
    kind: ProviderKind.Api,
    model: { invoke },
    models: ["m"],
    passthrough: raw,
    protocol,
    raw: { resolve: ({ protocol: inbound }) => (inbound === protocol ? { invoke: raw } : undefined) },
  } satisfies ApiProviderInstance & RuntimeProviderInstance;
  return { calls, value };
}

function modelStream(text: string): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-delta", id: "text-1", text });
      controller.enqueue({
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 },
          inputTokens: 0,
          outputTokenDetails: { reasoningTokens: 0, textTokens: 0 },
          outputTokens: 0,
          totalTokens: 0,
        },
      });
      controller.close();
    },
  });
}

async function request(inbound: InboundCase, providers: readonly RuntimeProviderInstance[], dbHome?: string) {
  const app = await createServer({
    config: { providers: {} },
    dbHome: dbHome ?? tempHome(),
    providerInstances: providers,
  });
  return app.request(inbound.path, {
    body: JSON.stringify(inbound.body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-cross-protocol-"));
  homes.push(home);
  return home;
}

async function recordedAttempts(home: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const handle = openDb({ home });
    const rows = handle.db.select().from(requestLog).all();
    handle.close();
    if (rows[0] !== undefined) return rows[0].attempts;
    await Bun.sleep(1);
  }
  throw new Error("request row was not recorded");
}

function expectModelResponse(protocol: ProviderProtocol, body: unknown, text: string): void {
  switch (protocol) {
    case ProviderProtocol.OpenAICompatible:
      expect(body).toMatchObject({ choices: [{ message: { role: "assistant", content: text } }] });
      break;
    case ProviderProtocol.OpenAIResponse:
      expect(body).toMatchObject({
        object: "response",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      });
      break;
    case ProviderProtocol.Anthropic:
      expect(body).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text }] });
      break;
    case ProviderProtocol.Gemini:
      expect(body).toMatchObject({ candidates: [{ content: { role: "model", parts: [{ text }] } }] });
      break;
  }
}
