import { describe, expect, test } from "bun:test";
import {
  anthropicMessagesAdapter,
  geminiGenerateContentAdapter,
  openAICompletionsAdapter,
  openAIResponsesAdapter,
} from "./index";
import { hashSession, MAX_SESSION_VALUE_LENGTH, normalizeSessionValue, selectSessionCandidate } from "./session";

describe("protocol sessions", () => {
  test("protocol candidates win over headers and are trimmed", () => {
    expect(
      selectSessionCandidate({
        protocol: [{ source: "openai-conversation", value: " conv_1 " }],
        headers: new Headers({ "x-session-id": "fallback", "x-client-request-id": "never-use" }),
      }),
    ).toEqual({ source: "openai-conversation", value: "conv_1" });
  });

  test("normalizes bounded values and namespaces hashes", () => {
    expect(normalizeSessionValue("   ")).toBeUndefined();
    expect(normalizeSessionValue(` ${"x".repeat(MAX_SESSION_VALUE_LENGTH + 10)} `)).toHaveLength(
      MAX_SESSION_VALUE_LENGTH,
    );
    expect(hashSession("body-session", "same")).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(hashSession("body-session", "same")).not.toBe(hashSession("body-conversation", "same"));
  });

  test.each([
    [
      "session_id before session-id and x-session-id",
      { session_id: "underscore", "session-id": "hyphen", "x-session-id": "x" },
      { source: "header-session", value: "underscore" },
    ],
    [
      "session-id before x-session-id",
      { "session-id": "hyphen", "x-session-id": "x" },
      { source: "header-session", value: "hyphen" },
    ],
    [
      "session aliases before conversation aliases",
      { "x-session-id": "session", conversation_id: "conversation" },
      { source: "header-session", value: "session" },
    ],
    [
      "conversation_id before conversation-id and x-conversation-id",
      { conversation_id: "underscore", "conversation-id": "hyphen", "x-conversation-id": "x" },
      { source: "header-conversation", value: "underscore" },
    ],
  ])("selects %s", (_label, headers, expected) => {
    expect(selectSessionCandidate({ protocol: [], headers: new Headers(headers) })).toEqual(expected);
  });

  test("request and idempotency headers are never session candidates", () => {
    expect(
      selectSessionCandidate({
        protocol: [],
        headers: new Headers({
          "x-client-request-id": "client",
          "x-request-id": "openai",
          "request-id": "anthropic",
          "idempotency-key": "retry",
        }),
      }),
    ).toBeUndefined();
  });

  test("OpenAI Responses orders native, cache, and body hints", () => {
    const request = openAIResponsesAdapter.parse(
      jsonRequest({
        model: "gpt",
        input: [{ role: "user", content: "hello" }],
        conversation: { id: "conv_native" },
        prompt_cache_key: "cache",
        previous_response_id: "resp_previous",
        metadata: { session_id: "meta_session", conversation_id: "meta_conversation" },
        session_id: "body_session",
        conversation_id: "body_conversation",
      }),
      {},
    );

    return request.then((parsed) => {
      expect(openAIResponsesAdapter.session?.(parsed, {})).toEqual({
        candidates: [
          { source: "openai-conversation", value: "conv_native" },
          { source: "openai-prompt-cache", value: "cache" },
          { source: "body-session", value: "meta_session" },
          { source: "body-conversation", value: "meta_conversation" },
          { source: "body-session", value: "body_session" },
          { source: "body-conversation", value: "body_conversation" },
        ],
        previousResponseId: "resp_previous",
        transcript: [{ role: "user", content: "hello" }],
      });
    });
  });

  test("Chat Completions and Gemini expose prompt and body extensions", async () => {
    const chat = await openAICompletionsAdapter.parse(
      jsonRequest({
        model: "gpt",
        messages: [{ role: "user", content: "hello" }],
        prompt_cache_key: "cache",
        metadata: { session_id: "meta" },
        conversation_id: "conversation",
      }),
      {},
    );
    expect(openAICompletionsAdapter.session?.(chat, {})).toEqual({
      candidates: [
        { source: "openai-prompt-cache", value: "cache" },
        { source: "body-session", value: "meta" },
        { source: "body-conversation", value: "conversation" },
      ],
      transcript: chat.messages,
    });

    const context = { model: "gemini", stream: false };
    const gemini = await geminiGenerateContentAdapter.parse(
      jsonRequest({
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        session_id: "session",
        conversation_id: "conversation",
      }),
      context,
    );
    expect(geminiGenerateContentAdapter.session?.(gemini, context)).toEqual({
      candidates: [
        { source: "body-session", value: "session" },
        { source: "body-conversation", value: "conversation" },
      ],
      transcript: gemini.contents,
    });
  });

  test.each([
    ["legacy", "user_123_account__session_claude-1", "claude-1"],
    ["JSON", '{"account":"user_123","session_id":"claude-2"}', "claude-2"],
  ])("accepts verified Claude Code %s metadata", async (_label, userId, expected) => {
    const parsed = await anthropicMessagesAdapter.parse(
      jsonRequest({
        model: "claude",
        messages: [{ role: "user", content: "hello" }],
        metadata: { user_id: userId },
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
      }),
      {},
    );
    expect(parsed).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
    expect(anthropicMessagesAdapter.session?.(parsed, {})?.candidates[0]).toEqual({
      source: "claude-code",
      value: expected,
    });
  });

  test.each([
    "ordinary-user",
    '{"session_id":1}',
    "user_account__session_",
  ])("rejects unverified Claude metadata: %s", async (userId) => {
    const parsed = await anthropicMessagesAdapter.parse(
      jsonRequest({
        model: "claude",
        messages: [{ role: "user", content: "hello" }],
        metadata: { user_id: userId, session_id: "fallback" },
      }),
      {},
    );
    expect(anthropicMessagesAdapter.session?.(parsed, {})?.candidates).toEqual([
      { source: "body-session", value: "fallback" },
    ]);
  });
});

function jsonRequest(body: unknown): Request {
  return new Request("https://proxy.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
