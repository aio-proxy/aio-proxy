import { describe, expect, test } from "bun:test";

import { createAiSdkProvider } from "../../index";
import {
  OPENAI_COMPATIBLE_TERMINAL,
  OPENAI_RESPONSES_TERMINAL,
  terminalThenErrorFetch,
} from "../openai-stream-fetch-test-helpers";
import { collect, messages } from "./ai-sdk-test-helpers";

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

const cases = [
  { packageName: "@ai-sdk/openai", options: { apiKey: "test" }, terminal: OPENAI_RESPONSES_TERMINAL },
  {
    packageName: "@ai-sdk/openai-compatible",
    options: { apiKey: "test", baseURL: "https://example.test/v1" },
    terminal: OPENAI_COMPATIBLE_TERMINAL,
  },
] as const;

describe("createAiSdkProvider OpenAI stream protection", () => {
  for (const { packageName, options, terminal } of cases) {
    test(`${packageName} finishes without observing a late body decode error`, async () => {
      const upstream = terminalThenErrorFetch({ terminal });
      const provider = createAiSdkProvider(
        { kind: "ai-sdk", id: `stream-${packageName}`, packageName, models: ["gpt-test"], options },
        { fetch: upstream.fetch },
      );
      const parts = await collect(provider.invoke({ messages, modelId: "gpt-test" }));
      expect(parts.some((part) => part.type === "finish")).toBe(true);
      expect(parts.some((part) => part.type === "error")).toBe(false);
      expect(upstream.secondPulls()).toBe(0);
      expect(upstream.cancelled()).toBe(true);
    });
  }
});
