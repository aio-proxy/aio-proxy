import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createPassthroughSseUsageObserver, type PassthroughObservation } from './passthrough-usage';

function collectTerminal(protocol: ProviderProtocol, frames: string): PassthroughObservation[] {
  const seen: PassthroughObservation[] = [];
  const observer = createPassthroughSseUsageObserver(protocol, { onTerminal: (obs) => seen.push(obs) });
  observer.feed(frames);
  return seen;
}

describe('observer onTerminal detection', () => {
  test('OpenAIResponse response.completed fires success terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAIResponse,
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","id":"resp_1","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBeUndefined();
    expect(seen[0]?.responseId).toBe('resp_1');
  });

  test('Anthropic message_stop fires success terminal', () => {
    const seen = collectTerminal(ProviderProtocol.Anthropic, 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBeUndefined();
  });

  test('OpenAICompatible [DONE] fires success terminal after trailing usage', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAICompatible,
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n' +
        'data: [DONE]\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBeUndefined();
    expect(seen[0]?.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });

  test('OpenAICompatible finish_reason alone does not fire terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAICompatible,
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    );
    expect(seen).toHaveLength(0);
  });

  test('Gemini finishReason fires success terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.Gemini,
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBeUndefined();
  });

  test('OpenAIResponse response.failed fires failure terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAIResponse,
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBe(true);
  });

  test('content delta does not fire terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAIResponse,
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    );
    expect(seen).toHaveLength(0);
  });
});
