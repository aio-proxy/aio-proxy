import type { OAuthAdapter, PluginDescriptor } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { ChatGPTCredential } from "./src/schema";

import { openAIChatGPTClientId } from "./rslib.config";

test("build embeds the ChatGPT OAuth client ID without leaving source plaintext", async () => {
  const [source, config, setup, artifact] = await Promise.all([
    Bun.file("./src/oauth-flow.ts").text(),
    Bun.file("./rslib.config.ts").text(),
    Bun.file("./test/setup.ts").text(),
    Bun.file("./dist/oauth-flow.js").text(),
  ]);

  expect(new Bun.CryptoHasher("sha256").update(openAIChatGPTClientId).digest("hex")).toBe(
    "584341c2f0e88ad1f7c6856553d81dc4776ff42c43951daed3e2d8d91552eaa2",
  );
  for (const text of [source, config, setup]) {
    expect(text.includes(openAIChatGPTClientId)).toBe(false);
    expect(text.includes(btoa(openAIChatGPTClientId))).toBe(false);
  }
  expect(artifact.includes(openAIChatGPTClientId)).toBe(true);
  expect(artifact.includes("__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__")).toBe(false);
  expect(/\batob\s*\(/u.test(artifact)).toBe(false);
});

test("clean build resolves the current runtime entry and exposes Responses raw capability", async () => {
  const [{ default: descriptor }, pluginArtifact] = await Promise.all([
    import("./dist/index.js"),
    Bun.file("./dist/plugin.js").text(),
  ]);
  const adapter = await registeredAdapter(descriptor);
  const runtime = await adapter.createRuntime({
    credentials: {
      read: async () => ({
        revision: 1,
        value: {
          accessToken: "artifact-access",
          accountId: "artifact-account",
          expiresAt: Date.now() + 60_000,
          refreshToken: "artifact-refresh",
        },
      }),
      refresh: async () => {
        throw new Error("artifact test must not refresh credentials");
      },
    },
    options: {},
    catalog: {
      language: [{ id: "gpt-artifact" }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    },
  });

  expect(pluginArtifact).toContain('from "./runtime/index.js"');
  expect(runtime.raw?.({ protocol: "openai-response", modelId: "gpt-artifact" })).toBeDefined();
  expect(runtime.raw?.({ protocol: "openai-compatible", modelId: "gpt-artifact" })).toBeUndefined();
});

async function registeredAdapter(
  descriptor: PluginDescriptor,
): Promise<OAuthAdapter<Record<string, never>, ChatGPTCredential>> {
  let adapter: OAuthAdapter<Record<string, never>, ChatGPTCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(value) {
          adapter = value as OAuthAdapter<Record<string, never>, ChatGPTCredential>;
        },
      },
      logger: {
        debug() {},
        error() {},
        info() {},
        warn() {},
        child() {
          return this;
        },
      },
    },
    undefined,
  );
  if (adapter === undefined) throw new Error("built plugin did not register its OAuth adapter");
  return adapter;
}
