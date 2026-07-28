import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

function ssePassthrough(body: string, protocol: ProviderProtocol = ProviderProtocol.OpenAICompatible) {
  return createUsageCapture().passthrough({
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    protocol,
    providerId: 'provider',
    modelId: 'model',
    startedAt: performance.now(),
  });
}

async function drain(response: Response): Promise<void> {
  await response.text();
}

describe('usage capture passthrough ttft', () => {
  test('records ttft only once a content delta arrives, not on the first byte', async () => {
    const captured = ssePassthrough(
      // Lifecycle/role frame first (no generated content), then a content delta.
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
    );
    await drain(captured.value);
    const completion = await captured.completion;

    expect(completion.outcome).toBe('success');
    const ttftMs = 'ttftMs' in completion ? completion.ttftMs : undefined;
    expect(typeof ttftMs).toBe('number');
    expect(ttftMs).toBeGreaterThanOrEqual(0);
  });

  test('records ttft from an OpenAI Responses SSE event name when data omits type', async () => {
    const captured = ssePassthrough(
      'event: response.output_text.delta\n' +
        'data: {"delta":"OK"}\n\n' +
        'event: response.completed\n' +
        'data: {"response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ProviderProtocol.OpenAIResponse,
    );
    await drain(captured.value);
    const completion = await captured.completion;

    expect(completion.outcome).toBe('success');
    const ttftMs = 'ttftMs' in completion ? completion.ttftMs : undefined;
    expect(typeof ttftMs).toBe('number');
  });

  test('omits ttft when the stream carries no content delta', async () => {
    const captured = ssePassthrough(
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":0,"total_tokens":3}}\n\n',
    );
    await drain(captured.value);
    const completion = await captured.completion;

    expect(completion.outcome).toBe('success');
    expect('ttftMs' in completion ? completion.ttftMs : undefined).toBeUndefined();
  });

  test('ignores Anthropic tool-argument deltas and records ttft on the first text delta', async () => {
    const captured = ssePassthrough(
      // input_json_delta carries tool arguments, not generated content: no ttft.
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n' +
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
        'data: {"type":"message_delta","usage":{"input_tokens":3,"output_tokens":2}}\n\n',
      ProviderProtocol.Anthropic,
    );
    await drain(captured.value);
    const completion = await captured.completion;

    expect(completion.outcome).toBe('success');
    const ttftMs = 'ttftMs' in completion ? completion.ttftMs : undefined;
    expect(typeof ttftMs).toBe('number');
  });

  test('omits ttft for an Anthropic stream that only emits tool-argument deltas', async () => {
    const captured = ssePassthrough(
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n' +
        'data: {"type":"message_delta","usage":{"input_tokens":3,"output_tokens":1}}\n\n',
      ProviderProtocol.Anthropic,
    );
    await drain(captured.value);
    const completion = await captured.completion;

    expect(completion.outcome).toBe('success');
    expect('ttftMs' in completion ? completion.ttftMs : undefined).toBeUndefined();
  });
});
