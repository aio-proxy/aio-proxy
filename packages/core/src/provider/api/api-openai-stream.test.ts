import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import type { ApiProviderTrace } from "./api";

import {
  OPENAI_COMPATIBLE_TERMINAL,
  OPENAI_RESPONSES_TERMINAL,
  terminalThenErrorFetch,
} from "../openai-stream-fetch-test-helpers";
import { createApiProvider } from "./api";

async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function waitForTrace(trace: readonly ApiProviderTrace[]): Promise<ApiProviderTrace> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (trace[0] !== undefined) return trace[0];
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("trace was not recorded");
}

const responsesUpstream = terminalThenErrorFetch({
  terminal: OPENAI_RESPONSES_TERMINAL,
  contentEncoding: "zstd",
});
const compatibleUpstream = terminalThenErrorFetch({
  terminal: OPENAI_COMPATIBLE_TERMINAL,
  contentEncoding: "zstd",
});

const cases = [
  {
    id: "responses",
    protocol: ProviderProtocol.OpenAIResponse,
    path: "/v1/responses",
    terminal: OPENAI_RESPONSES_TERMINAL,
    upstream: responsesUpstream,
  },
  {
    id: "compatible",
    protocol: ProviderProtocol.OpenAICompatible,
    path: "/v1/chat/completions",
    terminal: OPENAI_COMPATIBLE_TERMINAL,
    upstream: compatibleUpstream,
  },
] as const;

describe("createApiProvider OpenAI stream protection", () => {
  for (const { id, protocol, path, terminal, upstream } of cases) {
    test(`${id} closes at compressed terminal without a late decode error`, async () => {
      const trace: ApiProviderTrace[] = [];
      const provider = createApiProvider(
        { kind: "api", id, protocol, baseURL: "https://upstream.test/v1", trace },
        { fetch: upstream.fetch },
      );
      const response = await provider.passthrough(new Request(`https://proxy.test${path}?stream=true`));

      expect(upstream.decompress()).toBe(false);
      expect(upstream.acceptEncoding()).toBe("gzip, deflate, br, zstd");
      expect(await response.text()).toBe(terminal);
      expect(upstream.secondPulls()).toBe(0);
      expect(upstream.cancelled()).toBe(true);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(await waitForTrace(trace)).toEqual({
        bodySha256: await sha256Text(terminal),
        category: undefined,
        status: 200,
      });
    });
  }
});
