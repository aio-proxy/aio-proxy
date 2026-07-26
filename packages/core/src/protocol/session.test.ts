import { describe, expect, test } from 'bun:test';

import { openAIResponsesAdapter } from './index';
import { MAX_SESSION_VALUE_LENGTH, hashSession, normalizeSessionValue, selectSessionCandidate } from './session';

describe('protocol sessions', () => {
  test('protocol candidates win over headers and are trimmed', () => {
    expect(
      selectSessionCandidate({
        protocol: [{ source: 'openai-conversation', value: ' conv_1 ' }],
        headers: new Headers({ 'x-session-id': 'fallback', 'x-client-request-id': 'never-use' }),
      }),
    ).toEqual({ source: 'openai-conversation', value: 'conv_1' });
  });

  test('normalizes bounded values and namespaces hashes', () => {
    expect(normalizeSessionValue('   ')).toBeUndefined();
    expect(normalizeSessionValue(` ${'x'.repeat(MAX_SESSION_VALUE_LENGTH + 10)} `)).toHaveLength(
      MAX_SESSION_VALUE_LENGTH,
    );
    expect(hashSession('body-session', 'same')).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(hashSession('body-session', 'same')).not.toBe(hashSession('body-conversation', 'same'));
  });

  test.each([
    [
      'session_id before session-id and x-session-id',
      { session_id: 'underscore', 'session-id': 'hyphen', 'x-session-id': 'x' },
      { source: 'header-session', value: 'underscore' },
    ],
    [
      'session-id before x-session-id',
      { 'session-id': 'hyphen', 'x-session-id': 'x' },
      { source: 'header-session', value: 'hyphen' },
    ],
    [
      'session aliases before conversation aliases',
      { 'x-session-id': 'session', conversation_id: 'conversation' },
      { source: 'header-session', value: 'session' },
    ],
    [
      'conversation_id before conversation-id and x-conversation-id',
      { conversation_id: 'underscore', 'conversation-id': 'hyphen', 'x-conversation-id': 'x' },
      { source: 'header-conversation', value: 'underscore' },
    ],
  ])('selects %s', (_label, headers, expected) => {
    expect(selectSessionCandidate({ protocol: [], headers: new Headers(headers) })).toEqual(expected);
  });

  test('request and idempotency headers are never session candidates', () => {
    expect(
      selectSessionCandidate({
        protocol: [],
        headers: new Headers({
          'x-client-request-id': 'client',
          'x-request-id': 'openai',
          'request-id': 'anthropic',
          'idempotency-key': 'retry',
        }),
      }),
    ).toBeUndefined();
  });

  test('OpenAI Responses orders native, cache, and body hints', () => {
    const request = openAIResponsesAdapter.parse(
      jsonRequest({
        model: 'gpt',
        input: [{ role: 'user', content: 'hello' }],
        conversation: { id: 'conv_native' },
        prompt_cache_key: 'cache',
        previous_response_id: 'resp_previous',
        metadata: { session_id: 'meta_session', conversation_id: 'meta_conversation' },
        session_id: 'body_session',
        conversation_id: 'body_conversation',
      }),
      {},
    );

    return request.then((parsed) => {
      expect(openAIResponsesAdapter.session?.(parsed, {})).toEqual({
        candidates: [
          { source: 'openai-conversation', value: 'conv_native' },
          { source: 'openai-prompt-cache', value: 'cache' },
          { source: 'body-session', value: 'meta_session' },
          { source: 'body-conversation', value: 'meta_conversation' },
          { source: 'body-session', value: 'body_session' },
          { source: 'body-conversation', value: 'body_conversation' },
        ],
        previousResponseId: 'resp_previous',
        transcript: [{ role: 'user', content: 'hello' }],
      });
      expect(openAIResponsesAdapter.modelInvocation(parsed, {}).messages).toHaveLength(1);
    });
  });
});

function jsonRequest(body: unknown): Request {
  return new Request('https://proxy.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
