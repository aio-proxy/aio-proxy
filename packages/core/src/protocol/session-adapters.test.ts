import { describe, expect, test } from 'bun:test';

import { anthropicMessagesAdapter, geminiGenerateContentAdapter, openAICompletionsAdapter } from './index';

describe('protocol sessions', () => {
  test('Chat Completions and Gemini expose prompt and body extensions', async () => {
    const chat = await openAICompletionsAdapter.parse(
      jsonRequest({
        model: 'gpt',
        messages: [{ role: 'user', content: 'hello' }],
        prompt_cache_key: 'cache',
        metadata: { session_id: 'meta' },
        conversation_id: 'conversation',
      }),
      {},
    );
    expect(openAICompletionsAdapter.session?.(chat, {})).toEqual({
      candidates: [
        { source: 'openai-prompt-cache', value: 'cache' },
        { source: 'body-session', value: 'meta' },
        { source: 'body-conversation', value: 'conversation' },
      ],
      transcript: chat.messages,
    });

    const context = { model: 'gemini', stream: false };
    const gemini = await geminiGenerateContentAdapter.parse(
      jsonRequest({
        contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
        session_id: 'session',
        conversation_id: 'conversation',
      }),
      context,
    );
    expect(geminiGenerateContentAdapter.session?.(gemini, context)).toEqual({
      candidates: [
        { source: 'body-session', value: 'session' },
        { source: 'body-conversation', value: 'conversation' },
      ],
      transcript: gemini.contents,
    });
  });

  test.each([
    ['legacy', 'user_123_account__session_claude-1', 'claude-1'],
    ['JSON', '{"account":"user_123","session_id":"claude-2"}', 'claude-2'],
  ])('accepts verified Claude Code %s metadata', async (_label, userId, expected) => {
    const parsed = await anthropicMessagesAdapter.parse(
      jsonRequest({
        model: 'claude',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { user_id: userId },
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      }),
      {},
    );
    expect(parsed).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(anthropicMessagesAdapter.session?.(parsed, {})?.candidates[0]).toEqual({
      source: 'claude-code',
      value: expected,
    });
  });

  test('uses an ordinary Anthropic user ID only after explicit session candidates', async () => {
    const parsed = await anthropicMessagesAdapter.parse(
      jsonRequest({
        model: 'claude',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: {
          user_id: 'codex-thread-42',
          session_id: 'explicit-session',
          conversation_id: 'explicit-conversation',
        },
        session_id: 'top-session',
        conversation_id: 'top-conversation',
      }),
      {},
    );

    expect(anthropicMessagesAdapter.session?.(parsed, {})?.candidates).toEqual([
      { source: 'body-session', value: 'explicit-session' },
      { source: 'body-conversation', value: 'explicit-conversation' },
      { source: 'body-session', value: 'top-session' },
      { source: 'body-conversation', value: 'top-conversation' },
      { source: 'anthropic-user', value: 'codex-thread-42' },
    ]);
  });
});

function jsonRequest(body: unknown): Request {
  return new Request('https://proxy.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
