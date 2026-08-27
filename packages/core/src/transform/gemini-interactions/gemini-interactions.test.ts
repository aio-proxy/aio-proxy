import { describe, expect, test } from 'bun:test';

import { GeminiInteractionsTransformError, GeminiInteractionsUnsupportedFeatureError } from '../../error';
import { parseGeminiInteractions } from '../../ingress/gemini-interactions/index';
import { geminiInteractionsDimensions, geminiInteractionsToModelMessages } from './gemini-interactions';

const convert = (body: unknown) => geminiInteractionsToModelMessages(parseGeminiInteractions(body));

describe('geminiInteractionsToModelMessages', () => {
  test('maps the language subset', () => {
    const result = convert({
      model: 'gemini-3.5-flash',
      input: 'hello',
      system_instruction: 'sys',
      store: false,
      tools: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }],
      generation_config: {
        max_output_tokens: 16,
        seed: 1,
        stop_sequences: ['END'],
        thinking_level: 'low',
        thinking_summaries: 'none',
        tool_choice: { allowed_tools: { mode: 'auto' } },
      },
      response_format: [{ type: 'text', mime_type: 'text/plain' }],
    });
    expect(result.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    expect(result.tools).toEqual([
      { type: 'function', name: 'get_weather', description: 'w', inputSchema: { type: 'object' } },
    ]);
    expect(result.settings).toMatchObject({
      maxOutputTokens: 16,
      seed: 1,
      stopSequences: ['END'],
      reasoning: 'low',
      toolChoice: 'auto',
    });
    expect(result).not.toHaveProperty('dimensions');
    expect(result.settings).not.toHaveProperty('responseFormat');
  });

  test('dimensions helper canonicalizes thinking_level without convert eligibility', () => {
    const high = parseGeminiInteractions({
      model: 'm',
      input: 'hi',
      generation_config: { thinking_level: 'HIGH' },
    });
    expect(geminiInteractionsDimensions(high)).toEqual({ thinking: true, effort: 'high' });

    const agent = parseGeminiInteractions({
      agent: 'deep-research-preview-04-2026',
      input: 'hi',
      generation_config: { thinking_level: ' high ' },
    });
    expect(geminiInteractionsDimensions(agent)).toEqual({ thinking: true, effort: 'high' });
  });

  test('maps thought summary and function history', () => {
    const result = convert({
      model: 'm',
      store: false,
      input: [
        { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
        { type: 'thought', summary: [{ type: 'text', text: 'plan' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'ok' }] },
        { type: 'function_call', id: 'c1', name: 't', arguments: { a: 1 } },
        { type: 'function_result', call_id: 'c1', name: 't', result: { ok: true } },
      ],
    });
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
      'assistant',
      'tool',
    ]);
  });

  test('preserves a JSON-null function result', () => {
    const result = convert({
      model: 'm',
      store: false,
      input: [
        { type: 'function_call', id: 'c1', name: 't', arguments: {} },
        { type: 'function_result', call_id: 'c1', result: null },
      ],
    });
    expect(result.messages[1]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 't',
          output: { type: 'json', value: null },
        },
      ],
    });
  });

  test('keeps intervening model_output and thought on the pending function-call turn', () => {
    const result = convert({
      model: 'm',
      store: false,
      input: [
        { type: 'function_call', id: 'c1', name: 't', arguments: { a: 1 } },
        { type: 'thought', summary: [{ type: 'text', text: 'plan' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'function_result', call_id: 'c1', result: 'A' },
      ],
    });
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: { a: 1 } },
          { type: 'reasoning', text: 'plan' },
          { type: 'text', text: 'Hello' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 't',
            output: { type: 'text', value: 'A' },
          },
        ],
      },
    ]);
  });

  test('groups consecutive parallel function calls and results', () => {
    const result = convert({
      model: 'm',
      store: false,
      input: [
        { type: 'function_call', id: 'c1', name: 'read_a', arguments: { path: 'a' } },
        { type: 'function_call', id: 'c2', name: 'read_b', arguments: { path: 'b' } },
        { type: 'function_result', call_id: 'c1', result: 'A' },
        { type: 'function_result', call_id: 'c2', result: 'B' },
      ],
    });
    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'read_a', input: { path: 'a' } },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'read_b', input: { path: 'b' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'read_a',
            output: { type: 'text', value: 'A' },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'read_b',
            output: { type: 'text', value: 'B' },
          },
        ],
      },
    ]);
  });

  test.each([
    [{ model: 'm', input: 'x', agent_config: {} }, 'agent_config'],
    [{ agent: 'deep-research-preview-04-2026', input: 'x' }, 'agent'],
    [{ model: 'm', input: 'x' }, 'store'],
    [{ model: 'm', input: 'x', store: true }, 'store'],
    [{ model: 'm', input: 'x', store: false, background: true }, 'background'],
    [{ model: 'm', input: 'x', store: false, previous_interaction_id: 'ix' }, 'previous_interaction_id'],
    [
      { model: 'm', input: 'x', store: false, generation_config: { temperature: 0.2 } },
      'generation_config.temperature',
    ],
    [
      { model: 'm', input: 'x', store: false, generation_config: { max_output_tokens: 1.5 } },
      'generation_config.max_output_tokens',
    ],
    [
      { model: 'm', input: 'x', store: false, generation_config: { max_output_tokens: 0 } },
      'generation_config.max_output_tokens',
    ],
    [{ model: 'm', input: 'x', store: false, generation_config: { seed: 1.5 } }, 'generation_config.seed'],
    [
      { model: 'm', input: 'x', store: false, generation_config: { thinking_summaries: 'auto' } },
      'generation_config.thinking_summaries',
    ],
    [
      { model: 'm', input: 'x', store: false, generation_config: { tool_choice: 'any' } },
      'generation_config.tool_choice',
    ],
    [
      {
        model: 'm',
        input: 'x',
        store: false,
        generation_config: { tool_choice: { allowed_tools: { mode: 'auto', tools: ['t'] } } },
      },
      'generation_config.tool_choice',
    ],
    [
      { model: 'm', input: 'x', store: false, response_format: { type: 'text', mime_type: 'application/json' } },
      'response_format',
    ],
    [{ model: 'm', input: 'x', store: false, response_format: [] }, 'response_format'],
    [
      { model: 'm', input: 'x', store: false, response_format: [{ type: 'text' }, { type: 'text' }] },
      'response_format',
    ],
    [{ model: 'm', input: 'x', store: false, tools: [{ google_search: {} }] }, 'tools'],
    [{ model: 'm', input: 'x', store: false, tools: [{ name: '' }] }, 'tools'],
    [{ model: 'm', input: 'x', store: false, tools: [{ name: ' ' }] }, 'tools'],
    [{ model: 'm', input: 'x', store: false, tools: [{ name: 't', parameters: 'not-json' }] }, 'tools'],
    [
      {
        model: 'm',
        input: 'x',
        store: false,
        tools: [
          { name: 't', parameters: { type: 'object', properties: { a: {} } } },
          { name: 't', parameters: { type: 'object', properties: { b: {} } } },
        ],
      },
      'tools',
    ],
    [
      {
        model: 'm',
        input: [
          { type: 'text', text: 'ok' },
          { type: 'text', text: 123 },
        ],
        store: false,
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }, { type: 'model_output' }],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
          { type: 'function_call', name: 't' },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [{ type: 'function_call', id: ' ', name: 't', arguments: {} }],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [{ type: 'function_call', id: 'c1', name: ' ', arguments: {} }],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'function_call', id: 'c1', name: 't', arguments: {} },
          { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
          { type: 'function_result', call_id: 'c1', result: 'A' },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'function_call', id: 'c1', name: 't', arguments: {} },
          { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'function_call', id: 'a', name: 't', arguments: {} },
          { type: 'function_call', id: 'b', name: 'u', arguments: {} },
          { type: 'function_result', call_id: 'a', result: 'A' },
          { type: 'model_output', content: [{ type: 'text', text: 'Hello' }] },
          { type: 'function_result', call_id: 'b', result: 'B' },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
          { type: 'model_output', content: '' },
          { type: 'user_input', content: [{ type: 'text', text: 'next' }] },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
          { type: 'function_result', name: 't', result: { ok: true } },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
          { type: 'function_result', call_id: 'missing', result: { ok: true } },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'function_call', id: 'c1', name: 'foo', arguments: {} },
          { type: 'function_result', call_id: 'c1', name: 'bar', result: { ok: true } },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'function_call', id: 'c1', name: 't', arguments: {} },
          { type: 'function_result', call_id: 'c1', result: 'A' },
          { type: 'function_result', call_id: 'c1', result: 'B' },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'function_call', id: 'c1', name: 't', arguments: {} },
          { type: 'function_call', id: 'c1', name: 'u', arguments: {} },
        ],
      },
      'input',
    ],
    [
      {
        model: 'm',
        store: false,
        input: [
          { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
          { type: 'function_call', id: 'c1', name: 't', arguments: {} },
          { type: 'function_result', call_id: 'c1' },
        ],
      },
      'input',
    ],
    [{ model: 'm', input: [{ type: 'thought', content: [{ type: 'text', text: 'x' }] }], store: false }, 'input'],
    [{ model: 'm', input: 'x', store: false, labels: {} }, 'labels'],
  ])('throws modelUnsupported for %j', (body, feature) => {
    expect(() => convert(body)).toThrow(GeminiInteractionsUnsupportedFeatureError);
    try {
      convert(body);
    } catch (error) {
      expect(error).toBeInstanceOf(GeminiInteractionsUnsupportedFeatureError);
      if (error instanceof GeminiInteractionsUnsupportedFeatureError) {
        expect(error.feature).toBe(feature);
        expect(error.status).toBe(501);
      }
    }
  });

  test('empty convertible transcript is request-terminal', () => {
    expect(() => convert({ model: 'm', input: '', store: false })).toThrow(GeminiInteractionsTransformError);
    expect(() => convert({ model: 'm', input: [], store: false })).toThrow(GeminiInteractionsTransformError);
    expect(() => convert({ model: 'm', input: { type: 'text', text: '' }, store: false })).toThrow(
      GeminiInteractionsTransformError,
    );
    expect(() => convert({ model: 'm', input: [{ type: 'text', text: '' }], store: false })).toThrow(
      GeminiInteractionsTransformError,
    );
  });
});
