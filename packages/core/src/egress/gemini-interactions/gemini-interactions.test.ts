import { describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '../../ai-sdk-bridge';
import { writeGeminiInteractionsResponse } from './json';
import { interactionStatus } from './status';

const empty = { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 };

function streamOf(...parts: TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function finish(reason: string, usage?: Partial<TextStreamPart<ToolSet> & { type: 'finish' }>['totalUsage']) {
  return {
    type: 'finish' as const,
    finishReason: reason,
    rawFinishReason: reason,
    totalUsage: {
      inputTokenDetails: empty,
      inputTokens: 7,
      outputTokenDetails: { reasoningTokens: 22, textTokens: 20 },
      outputTokens: 42,
      totalTokens: 49,
      ...usage,
    },
  };
}

describe('interactionStatus', () => {
  test('maps string finish reasons', () => {
    expect(interactionStatus('error', false)).toBe('error');
    expect(interactionStatus('tool-calls', false)).toBe('requires_action');
    expect(interactionStatus('other', true)).toBe('requires_action');
    expect(interactionStatus('unknown', true)).toBe('requires_action');
    expect(interactionStatus('length', false)).toBe('incomplete');
    expect(interactionStatus('content-filter', false)).toBe('incomplete');
    expect(interactionStatus('stop', false)).toBe('completed');
    expect(interactionStatus('other', false)).toBe('error');
    expect(interactionStatus('unknown', false)).toBe('error');
  });
});

describe('writeGeminiInteractionsResponse', () => {
  test('emits official usage names and completed text', async () => {
    const interaction = await writeGeminiInteractionsResponse(
      streamOf({ type: 'text-delta', id: 't', text: 'Hello' }, finish('stop')),
      { modelId: 'gemini-3.5-flash' },
    );
    expect(interaction).toMatchObject({
      object: 'interaction',
      model: 'gemini-3.5-flash',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Hello' }] }],
      usage: {
        total_input_tokens: 7,
        total_output_tokens: 20,
        total_thought_tokens: 22,
        total_cached_tokens: 0,
        total_tool_use_tokens: 0,
        total_tokens: 49,
      },
    });
    expect(interaction.usage).not.toHaveProperty('input_tokens');
    expect(interaction.usage).not.toHaveProperty('output_tokens');
    expect(JSON.stringify(Object.keys(interaction.usage))).not.toContain('"input_tokens"');
    expect(JSON.stringify(Object.keys(interaction.usage))).not.toContain('"output_tokens"');
    expect(interaction).not.toHaveProperty('agent');
  });

  test('requires_action for unmatched function_call even when finish is other', async () => {
    const interaction = await writeGeminiInteractionsResponse(
      streamOf(
        { type: 'tool-input-start', id: 'c1', toolName: 'get_weather' },
        { type: 'tool-input-delta', id: 'c1', delta: '{"location":"Boston, MA"}' },
        { type: 'tool-input-end', id: 'c1' },
        finish('other'),
      ),
      { modelId: 'm' },
    );
    expect(interaction.status).toBe('requires_action');
    expect(interaction.steps).toContainEqual({
      type: 'function_call',
      id: 'c1',
      name: 'get_weather',
      arguments: { location: 'Boston, MA' },
    });
  });

  test('thought step is summary-only', async () => {
    const interaction = await writeGeminiInteractionsResponse(
      streamOf(
        { type: 'reasoning-delta', id: 'r', text: 'plan' },
        { type: 'text-delta', id: 't', text: 'hi' },
        finish('stop'),
      ),
      { modelId: 'm' },
    );
    expect(interaction.steps[0]).toEqual({ type: 'thought', summary: [{ type: 'text', text: 'plan' }] });
    expect(interaction.steps[0]).not.toHaveProperty('content');
  });

  test('missing function_call id or name fails egress', async () => {
    await expect(
      writeGeminiInteractionsResponse(
        streamOf({ type: 'tool-input-start', id: '', toolName: 't' }, finish('tool-calls')),
        { modelId: 'm' },
      ),
    ).rejects.toThrow();
  });

  test('finish error and unmatched-less other never emit Interaction JSON', async () => {
    await expect(
      writeGeminiInteractionsResponse(streamOf({ type: 'text-delta', id: 't', text: 'x' }, finish('error')), {
        modelId: 'm',
      }),
    ).rejects.toThrow();
    await expect(
      writeGeminiInteractionsResponse(streamOf({ type: 'text-delta', id: 't', text: 'x' }, finish('other')), {
        modelId: 'm',
      }),
    ).rejects.toThrow();
    await expect(
      writeGeminiInteractionsResponse(streamOf({ type: 'text-delta', id: 't', text: 'x' }, finish('unknown')), {
        modelId: 'm',
      }),
    ).rejects.toThrow();
  });
});
