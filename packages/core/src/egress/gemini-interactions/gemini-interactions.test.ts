import { describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '../../ai-sdk-bridge';
import { GeminiInteractionsEgressError } from '../../error';
import { geminiInteractionsErrors } from '../../protocol/errors';
import { writeGeminiInteractionsResponse } from './json';
import { writeGeminiInteractionsSSE } from './sse';
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

  test('non-stream steps follow part-start order', async () => {
    const interaction = await writeGeminiInteractionsResponse(
      streamOf(
        { type: 'tool-input-start', id: 'c1', toolName: 'get_weather' },
        { type: 'tool-input-delta', id: 'c1', delta: '{"location":"Boston, MA"}' },
        { type: 'text-delta', id: 't', text: 'Hello' },
        finish('tool-calls'),
      ),
      { modelId: 'm' },
    );
    expect(interaction.steps).toEqual([
      { type: 'function_call', id: 'c1', name: 'get_weather', arguments: { location: 'Boston, MA' } },
      { type: 'model_output', content: [{ type: 'text', text: 'Hello' }] },
    ]);
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

  test.each(['other', 'unknown'] as const)(
    'finish %s with text is a typed egress error, not a provider Error',
    async (reason) => {
      let caught: unknown;
      try {
        await writeGeminiInteractionsResponse(streamOf({ type: 'text-delta', id: 't', text: 'x' }, finish(reason)), {
          modelId: 'm',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GeminiInteractionsEgressError);
      expect(geminiInteractionsErrors.provider(caught)).toBeUndefined();
      expect(
        geminiInteractionsErrors.provider(new Error(`Gemini Interactions convert finished with ${reason}`)),
      ).toBeDefined();
    },
  );
});

async function readSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function completedSteps(text: string): unknown {
  const match = text.match(/event: interaction\.completed\ndata: (\{.*\})\n/);
  const payload: unknown = JSON.parse(match?.[1] ?? '{}');
  const interaction =
    typeof payload === 'object' && payload !== null && 'interaction' in payload
      ? (payload as { interaction?: { steps?: unknown } }).interaction
      : undefined;
  return interaction?.steps;
}

function completedUsage(text: string): Record<string, unknown> {
  const match = text.match(/event: interaction\.completed\ndata: (\{.*\})\n/);
  const payload: unknown = JSON.parse(match?.[1] ?? '{}');
  const interaction =
    typeof payload === 'object' && payload !== null && 'interaction' in payload
      ? (payload as { interaction?: { usage?: unknown } }).interaction
      : undefined;
  const usage = interaction?.usage;
  return typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {};
}

describe('writeGeminiInteractionsSSE', () => {
  test('emits named events in official order', async () => {
    const text = await readSse(
      writeGeminiInteractionsSSE(streamOf({ type: 'text-delta', id: 't', text: 'Hello' }, finish('stop')), {
        modelId: 'gemini-3.5-flash',
      }),
    );
    expect(text).toContain('event: interaction.created');
    expect(text).toContain('event: interaction.status_update');
    expect(text).toContain('event: step.start');
    expect(text).toContain('event: step.delta');
    expect(text).toContain('event: step.stop');
    expect(text).toContain('event: interaction.completed');
    expect(text).toContain('event: done');
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('"event_id":"evt_1"');
    expect(text).toContain('"event_id":"evt_2"');
    expect(text).toContain('"event_type":"step.start","index":0');
    expect(text).toContain('"event_type":"step.delta","index":0');
    expect(text).toContain('"event_type":"step.stop","index":0');
    expect(text.match(/event: interaction.status_update/g)?.length).toBe(1);
    expect(text).not.toContain('"status":"completed"\n\nevent: interaction.status_update');
    const usage = completedUsage(text);
    expect(usage).toMatchObject({
      total_input_tokens: 7,
      total_output_tokens: 20,
      total_thought_tokens: 22,
      total_cached_tokens: 0,
      total_tool_use_tokens: 0,
      total_tokens: 49,
    });
    expect(usage).not.toHaveProperty('input_tokens');
    expect(usage).not.toHaveProperty('output_tokens');
    expect(Object.keys(usage)).not.toContain('input_tokens');
    expect(Object.keys(usage)).not.toContain('output_tokens');
    expect(text).not.toContain('"candidates"');
    const createdIdx = text.indexOf('event: interaction.created');
    const updateIdx = text.indexOf('event: interaction.status_update');
    const completedIdx = text.indexOf('event: interaction.completed');
    const doneIdx = text.indexOf('event: done');
    expect(createdIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(createdIdx);
    expect(completedIdx).toBeGreaterThan(updateIdx);
    expect(doneIdx).toBeGreaterThan(completedIdx);
  });

  test('function_call start includes id name and empty arguments', async () => {
    const text = await readSse(
      writeGeminiInteractionsSSE(
        streamOf(
          { type: 'tool-input-start', id: 'c1', toolName: 'get_weather' },
          { type: 'tool-input-delta', id: 'c1', delta: '{"location":"Boston, MA"}' },
          finish('tool-calls'),
        ),
        { modelId: 'm' },
      ),
    );
    expect(text).toContain('"step":{"type":"function_call","id":"c1","name":"get_weather","arguments":{}}');
    expect(text).toContain('"status":"requires_action"');
  });

  test('retains argument deltas after a later parallel function_call starts', async () => {
    const text = await readSse(
      writeGeminiInteractionsSSE(
        streamOf(
          { type: 'tool-input-start', id: 'c1', toolName: 'get_weather' },
          { type: 'tool-input-start', id: 'c2', toolName: 'get_time' },
          { type: 'tool-input-delta', id: 'c1', delta: '{"location":"Boston, MA"}' },
          { type: 'tool-input-delta', id: 'c2', delta: '{"tz":"ET"}' },
          finish('tool-calls'),
        ),
        { modelId: 'm' },
      ),
    );
    expect(text).toContain(
      '"event_type":"step.delta","index":0,"delta":{"type":"arguments_delta","arguments":"{\\"location\\":\\"Boston, MA\\"}"}',
    );
    expect(text).toContain(
      '"event_type":"step.delta","index":1,"delta":{"type":"arguments_delta","arguments":"{\\"tz\\":\\"ET\\"}"}',
    );
    expect(text).toContain(
      '"type":"function_call","id":"c1","name":"get_weather","arguments":{"location":"Boston, MA"}',
    );
    expect(text).toContain('"type":"function_call","id":"c2","name":"get_time","arguments":{"tz":"ET"}');
    expect(text).toContain('"status":"requires_action"');
  });

  test('completed steps follow streamed step.start order', async () => {
    const text = await readSse(
      writeGeminiInteractionsSSE(
        streamOf(
          { type: 'tool-input-start', id: 'c1', toolName: 'get_weather' },
          { type: 'tool-input-delta', id: 'c1', delta: '{"location":"Boston, MA"}' },
          { type: 'text-delta', id: 't', text: 'Hello' },
          finish('tool-calls'),
        ),
        { modelId: 'm' },
      ),
    );
    expect(text).toContain(
      '"event_type":"step.start","index":0,"step":{"type":"function_call","id":"c1","name":"get_weather","arguments":{}}',
    );
    expect(text).toContain('"event_type":"step.start","index":1,"step":{"type":"model_output"}');
    const completed = text.match(/event: interaction\.completed\ndata: (\{.*\})\n/);
    const payload: unknown = JSON.parse(completed?.[1] ?? '{}');
    const steps =
      typeof payload === 'object' && payload !== null && 'interaction' in payload
        ? (payload as { interaction?: { steps?: unknown } }).interaction?.steps
        : undefined;
    expect(steps).toEqual([
      { type: 'function_call', id: 'c1', name: 'get_weather', arguments: { location: 'Boston, MA' } },
      { type: 'model_output', content: [{ type: 'text', text: 'Hello' }] },
    ]);
  });

  test('retains function-call argument deltas after interleaved text', async () => {
    const text = await readSse(
      writeGeminiInteractionsSSE(
        streamOf(
          { type: 'tool-input-start', id: 'c1', toolName: 'get_weather' },
          { type: 'text-delta', id: 't', text: 'Hello' },
          { type: 'tool-input-delta', id: 'c1', delta: '{"location":"Boston, MA"}' },
          finish('tool-calls'),
        ),
        { modelId: 'm' },
      ),
    );
    expect(text).toContain(
      '"event_type":"step.delta","index":0,"delta":{"type":"arguments_delta","arguments":"{\\"location\\":\\"Boston, MA\\"}"}',
    );
    expect(completedSteps(text)).toEqual([
      { type: 'function_call', id: 'c1', name: 'get_weather', arguments: { location: 'Boston, MA' } },
      { type: 'model_output', content: [{ type: 'text', text: 'Hello' }] },
    ]);
  });

  test('completed model_output steps keep their own streamed text', async () => {
    const text = await readSse(
      writeGeminiInteractionsSSE(
        streamOf(
          { type: 'text-delta', id: 't1', text: 'A' },
          { type: 'tool-input-start', id: 'c1', toolName: 'get_weather' },
          { type: 'tool-input-delta', id: 'c1', delta: '{"location":"Boston, MA"}' },
          { type: 'text-delta', id: 't2', text: 'B' },
          finish('tool-calls'),
        ),
        { modelId: 'm' },
      ),
    );
    expect(completedSteps(text)).toEqual([
      { type: 'model_output', content: [{ type: 'text', text: 'A' }] },
      { type: 'function_call', id: 'c1', name: 'get_weather', arguments: { location: 'Boston, MA' } },
      { type: 'model_output', content: [{ type: 'text', text: 'B' }] },
    ]);
  });

  test('error finish emits error then done and never completed', async () => {
    const text = await readSse(
      writeGeminiInteractionsSSE(streamOf({ type: 'text-delta', id: 't', text: 'x' }, finish('error')), {
        modelId: 'm',
      }),
    );
    expect(text).toContain('event: error');
    expect(text).toContain('event: done');
    expect(text).not.toContain('event: interaction.completed');
  });

  test('missing function_call id or name emits error then done', async () => {
    const text = await readSse(
      writeGeminiInteractionsSSE(streamOf({ type: 'tool-input-start', id: '', toolName: 't' }, finish('tool-calls')), {
        modelId: 'm',
      }),
    );
    expect(text).toContain('event: error');
    expect(text).toContain('event: done');
    expect(text).toContain('data: [DONE]');
    expect(text).not.toContain('event: interaction.completed');
    expect(text).not.toContain('"type":"function_call"');
  });
});
