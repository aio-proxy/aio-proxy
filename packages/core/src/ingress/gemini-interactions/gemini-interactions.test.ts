import { describe, expect, test } from 'bun:test';

import { ZodError } from 'zod';

import { parseGeminiInteractions, safeParseGeminiInteractions } from './gemini-interactions';

describe('parseGeminiInteractions', () => {
  test('accepts model and strips models/ from the routing id only', () => {
    const parsed = parseGeminiInteractions({
      model: '  models/gemini-3.5-flash  ',
      input: 'hello',
    });
    expect(parsed.idField).toBe('model');
    expect(parsed.routingId).toBe('gemini-3.5-flash');
    expect(parsed.body.model).toBe('  models/gemini-3.5-flash  ');
  });

  test('accepts a bare agent id and does not strip agents/', () => {
    const parsed = parseGeminiInteractions({
      agent: 'deep-research-preview-04-2026',
      input: 'hello',
    });
    expect(parsed.idField).toBe('agent');
    expect(parsed.routingId).toBe('deep-research-preview-04-2026');
  });

  test('routes agents/foo as agents/foo', () => {
    const parsed = parseGeminiInteractions({ agent: 'agents/foo', input: 'hello' });
    expect(parsed.routingId).toBe('agents/foo');
  });

  test.each([
    {},
    { model: 'm' },
    { model: 'm', input: null },
    { model: 'm', input: 1 },
    { model: 'm', input: true },
    { model: '', input: 'x' },
    { agent: '  ', input: 'x' },
    { model: 'm', agent: 'a', input: 'x' },
    { model: 'm', agent: ' ', input: 'x' },
    { model: ' ', agent: 'a', input: 'x' },
    { model: 'm', input: 'x', stream: 'yes' },
    { model: 'm', input: 'x', system_instruction: { parts: [{ text: 'sys' }] } },
  ])('rejects %j', (body) => {
    expect(() => parseGeminiInteractions(body)).toThrow(ZodError);
    expect(safeParseGeminiInteractions(body).ok).toBe(false);
  });

  test('empty string and empty array input parse', () => {
    expect(parseGeminiInteractions({ model: 'm', input: '' }).body.input).toBe('');
    expect(parseGeminiInteractions({ model: 'm', input: [] }).body.input).toEqual([]);
  });

  test('absent stream is false; true is true', () => {
    expect(parseGeminiInteractions({ model: 'm', input: 'x' }).body.stream).toBeUndefined();
    expect(parseGeminiInteractions({ model: 'm', input: 'x', stream: true }).body.stream).toBe(true);
  });

  test('retains unknown official fields for convert 501', () => {
    const parsed = parseGeminiInteractions({
      model: 'm',
      input: 'x',
      previous_interaction_id: 'ix',
      extra_unknown: 1,
    });
    expect(parsed.body['previous_interaction_id']).toBe('ix');
    expect(parsed.body['extra_unknown']).toBe(1);
  });
});
