import type { LanguageModelV2 } from "@ai-sdk/provider";

import { describe, expect, test } from "bun:test";

import { createAiSdkProvider } from "../../index";
import { collect, messages, textPartStream } from "./ai-sdk-test-helpers";

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

describe("createAiSdkProvider reasoning stream", () => {
  test("Given DeepSeek openai-compatible raw reasoning chunk When invoked Then reasoning delta is surfaced", async () => {
    // Given
    const model = {
      specificationVersion: "v2",
      provider: "openai-compatible",
      modelId: "deepseek-reasoner",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "think first" } }],
              },
            },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "answer" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "deepseek",
        packageName: "@ai-sdk/openai-compatible",
        options: { name: "deepseek" },
        models: ["deepseek-reasoner"],
      },
      { resolveModel: () => model },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "deepseek-reasoner" }));

    // Then
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      {
        type: "reasoning-delta",
        id: "reasoning-aio-proxy",
        text: "think first",
      },
    ]);
  });

  test("Given DeepSeek stream has native and raw reasoning When invoked Then reasoning is not duplicated", async () => {
    // Given
    const model = {
      specificationVersion: "v2",
      provider: "openai-compatible",
      modelId: "deepseek-reasoner",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "think once" } }],
              },
            },
            { type: "reasoning-start", id: "reason-1" },
            { type: "reasoning-delta", id: "reason-1", delta: "think once" },
            { type: "reasoning-end", id: "reason-1" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "answer" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "deepseek",
        packageName: "@ai-sdk/openai-compatible",
        options: { name: "deepseek" },
        models: ["deepseek-reasoner"],
      },
      { resolveModel: () => model },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "deepseek-reasoner" }));

    // Then
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", id: "reason-1", text: "think once" },
    ]);
  });

  test("Given chunked DeepSeek stream has native and raw reasoning When invoked Then reasoning is emitted once", async () => {
    // Given
    const model = {
      specificationVersion: "v2",
      provider: "openai-compatible",
      modelId: "deepseek-reasoner",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "think " } }],
              },
            },
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "once" } }],
              },
            },
            { type: "reasoning-start", id: "reason-1" },
            { type: "reasoning-delta", id: "reason-1", delta: "think " },
            { type: "reasoning-delta", id: "reason-1", delta: "once" },
            { type: "reasoning-end", id: "reason-1" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "answer" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "deepseek",
        packageName: "@ai-sdk/openai-compatible",
        options: { name: "deepseek" },
        models: ["deepseek-reasoner"],
      },
      { resolveModel: () => model },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "deepseek-reasoner" }));

    // Then
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", id: "reason-1", text: "think " },
      { type: "reasoning-delta", id: "reason-1", text: "once" },
    ]);
  });

  test("Given parseReasoningContent true for openai-compatible model When invoked Then raw reasoning is surfaced", async () => {
    // Given
    const model = {
      specificationVersion: "v2",
      provider: "openai-compatible",
      modelId: "custom-reasoner",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "custom thought" } }],
              },
            },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "answer" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "compatible",
        packageName: "@ai-sdk/openai-compatible",
        parseReasoningContent: true,
        models: ["custom-reasoner"],
      },
      { resolveModel: () => model },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "custom-reasoner" }));

    // Then
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      {
        type: "reasoning-delta",
        id: "reasoning-aio-proxy",
        text: "custom thought",
      },
    ]);
  });
});
