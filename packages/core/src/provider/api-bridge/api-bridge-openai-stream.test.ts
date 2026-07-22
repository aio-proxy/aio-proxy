import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import { bridgeApiProviderToAiSdk } from "../../index";
import {
  OPENAI_COMPATIBLE_TERMINAL,
  OPENAI_RESPONSES_TERMINAL,
  terminalThenErrorFetch,
} from "../openai-stream-fetch-test-helpers";
import { collect, messages } from "./api-bridge-test-helpers";

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

const cases = [
  { protocol: ProviderProtocol.OpenAIResponse, terminal: OPENAI_RESPONSES_TERMINAL },
  { protocol: ProviderProtocol.OpenAICompatible, terminal: OPENAI_COMPATIBLE_TERMINAL },
] as const;

describe("bridgeApiProviderToAiSdk OpenAI stream protection", () => {
  for (const { protocol, terminal } of cases) {
    test(`${protocol} finishes without observing a late body decode error`, async () => {
      const upstream = terminalThenErrorFetch({ terminal });
      const bridge = bridgeApiProviderToAiSdk(
        {
          kind: ProviderKind.Api,
          id: `bridge-${protocol}`,
          protocol,
          apiKey: "test",
          baseURL: "https://upstream.test/v1",
          models: ["gpt-test"],
        },
        { fetch: upstream.fetch },
      );
      const parts = await collect(bridge.invoke({ messages, modelId: "gpt-test" }));
      expect(parts.some((part) => part.type === "finish")).toBe(true);
      expect(parts.some((part) => part.type === "error")).toBe(false);
      expect(upstream.secondPulls()).toBe(0);
      expect(upstream.cancelled()).toBe(true);
    });
  }
});
